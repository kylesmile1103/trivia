import { execFile, type ExecFileException } from 'node:child_process'
import fs from 'node:fs'

import { APP_DOC, loadDocument, MODEL_DOC, type Diagnostic } from '@trivia/blueprint'
import { DEFAULT_WEB_DIRECTORY, solutionFromWeb } from '@trivia/blueprint-compiler'
import { z } from 'zod'

import { ApiError } from '../engine.js'
import { checkedPath } from './paths.js'
import { readBytes, type BlueprintWorkspace } from './store.js'

interface BackendFile {
  path: string
  kind: 'generated' | 'scaffold'
  action: 'create' | 'update' | 'unchanged' | 'delete' | 'refused'
}

const renameSchema = z.object({
  kind: z.enum(['table', 'column']), entity: z.string(), field: z.string().optional(), from: z.string(),
  oldName: z.string(), newName: z.string(),
})
const settledSchema = z.object({
  entity: z.string(), field: z.string().optional(), from: z.string(),
  outcome: z.enum(['renamed', 'alreadyApplied', 'notInDatabase']),
})

/** A RenameTable or RenameColumn in the new migration that carries out a `renamedFrom` marker (LLD-09 §6). */
export type MigrationRename = z.infer<typeof renameSchema>

/** A marker the migration accounted for, by the entity's and field's current names. */
export type SettledMarker = z.infer<typeof settledSchema>

/** What a successful `trivia-dotnet migrate` reports. */
export interface MigrateResult {
  migration: string
  /** The model revision migrate read. Clearing its markers is guarded by it. */
  modelRev?: string
  renames: MigrationRename[]
  settled: SettledMarker[]
}

export interface BackendResult {
  files: BackendFile[]
  written: boolean
  diagnostics: Diagnostic[]
  log: string
  /** With a migration: the renames it made for `renamedFrom` markers. */
  renames?: MigrationRename[]
  next?: Array<
    | { command: string[]; cwd: string }
    | { tool: 'trivia_sync_openapi'; arguments: { input: string; zod: true } }
    | { tool: 'trivia_contract_drift'; arguments: Record<string, never> }
  >
}

/** Clears the markers a successful migration settled. Throws when they cannot be cleared. */
export type ClearRenameMarkers = (migrated: MigrateResult) => unknown

export const backendInput = z.strictObject({
  mode: z.enum(['plan', 'write']),
  migration: z.string().min(1).optional().describe(
    'With mode: write, generate the API and then add this named EF migration in the same call. Rename markers the migration settles are cleared.',
  ),
  force: z.boolean().optional().describe('Replace changed generated files in write mode without a migration.'),
})
export type BackendRequest = z.infer<typeof backendInput>

const fileSchema = z.object({
  path: z.string(),
  kind: z.enum(['generated', 'scaffold']),
  action: z.enum(['create', 'update', 'unchanged', 'delete']),
})
const cliResult = z.object({
  files: z.array(fileSchema).optional(),
  migration: z.string().optional(),
  modelRev: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  renames: z.array(renameSchema).optional(),
  settled: z.array(settledSchema).optional(),
  diagnostics: z.array(z.object({
    code: z.string(), doc: z.string(), pointer: z.string(), message: z.string(), severity: z.enum(['error', 'warning']),
  })),
})
const identifier = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]*$/u
const TOOL = 'trivia-dotnet'
const LOG_LIMIT = 4_000

function clipLog(log: string): string {
  const text = log.trim()
  const suffix = '\n… (truncated)'
  return text.length <= LOG_LIMIT ? text : text.slice(0, LOG_LIMIT - suffix.length) + suffix
}

function execute(name: string, args: string[], cwd: string, timeout: number) {
  return new Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>((resolve) => {
    execFile(name, args, {
      cwd, timeout, shell: false, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
}

function sdkUnavailable(): never {
  throw new ApiError('unsupported', 'The dotnet executable or required .NET runtime is unavailable.', {
    hint: 'Install the .NET 10 SDK and make dotnet available on PATH.',
  })
}

function decode(stdout: string, log: string): z.infer<typeof cliResult> {
  let value: unknown
  try {
    value = JSON.parse(stdout.trim())
  } catch {
    throw new ApiError('io_error', 'trivia-dotnet did not return JSON.', { log: clipLog([log, stdout].filter(Boolean).join('\n')) })
  }
  const parsed = cliResult.safeParse(value)
  if (!parsed.success) throw new ApiError('io_error', 'trivia-dotnet returned an invalid result.', { log })
  return parsed.data
}

/** Runs one trivia-dotnet command and maps a missing tool, a timeout or a crash to an ApiError. */
async function invoke(args: string[], cwd: string, timeout: number) {
  const { error, stdout, stderr } = await execute(TOOL, args, cwd, timeout)
  const log = clipLog(stderr)
  if (error?.code === 'ENOENT') {
    const sdk = await execute('dotnet', ['--version'], cwd, 5_000)
    if (sdk.error) sdkUnavailable()
    throw new ApiError('unsupported', 'The trivia-dotnet tool is unavailable.', {
      hint: 'Install the Trivia.Blueprint.Codegen .NET tool and make trivia-dotnet available on PATH.',
    })
  }
  if (error && /you must install (?:or update )?\.net|could not find libhostfxr/i.test(stderr)) sdkUnavailable()
  if (error?.killed && error.code === null) {
    throw new ApiError('io_error', 'trivia-dotnet timed out.', { timeoutMs: timeout, log })
  }
  const status = error === null ? 0 : error.code
  if (status !== 0 && status !== 1 && status !== 2) {
    throw new ApiError('io_error', 'Could not run trivia-dotnet.', { log: log || clipLog(error?.message ?? '') })
  }
  return { status, result: decode(stdout, log), log: stderr }
}

/** The markers a successful migration lets the model drop: every one it settled (LLD-08 §4). */
export function markersToClear(migrated: MigrateResult): Array<{ entity: string; field?: string; from: string }> {
  return migrated.settled.map(({ entity, field, from }) => ({ entity, ...(field !== undefined && { field }), from }))
}

/**
 * Plan or write the backend. With a migration, write runs first and migrate second in the same queued call,
 * so the migration is made from the current generated code; a write that exits non-zero stops before migrate.
 * After a successful migrate, `clear` removes the markers it settled.
 */
export async function runBackend(
  workspace: BlueprintWorkspace, { mode, migration, force }: BackendRequest, clear: ClearRenameMarkers,
): Promise<BackendResult> {
  if (migration !== undefined && (mode !== 'write' || !identifier.test(migration))) {
    throw new ApiError('invalid_op', 'Pass a valid C# migration name with mode: write.')
  }
  if (force && (mode !== 'write' || migration !== undefined)) {
    throw new ApiError('invalid_op', 'Force applies to a backend write without a migration.')
  }

  const web = fs.realpathSync(workspace.root)
  const blueprint = checkedPath(web, workspace.dir)
  // The CLI reads these two documents directly. Apply the service's symlink guard first.
  for (const file of [APP_DOC, MODEL_DOC]) checkedPath(web, `${workspace.dir}/${file}`)
  const source = workspace.readDocumentText(APP_DOC)
  const entry = source === null ? null : loadDocument(APP_DOC, source)
  const app = entry?.kind === 'app' ? entry.doc : null
  const layout = app?.targets.api === 'dotnet-minimal' ? configuredSolution(web) : null
  const root = layout?.root ?? web
  const shared = ['--blueprint', blueprint, '--root', root]
  const location = layout && layout.webDirectory !== DEFAULT_WEB_DIRECTORY ? ['--web-dir', layout.webDirectory] : []

  const generated = await invoke([mode, ...shared, ...location, ...(force ? ['--force'] : [])], root, 120_000)
  const files: BackendFile[] = (generated.result.files ?? []).map((file) =>
    generated.status === 2 && file.action !== 'unchanged' ? { ...file, action: 'refused' } : file)
  const written = mode === 'write' && generated.status === 0 && files.some(({ action }) => action !== 'unchanged')
  const next = {
    next: [
      { command: ['dotnet', 'build', ...(app ? [app.name + '.slnx'] : [])], cwd: root },
      { tool: 'trivia_sync_openapi' as const, arguments: { input: 'openapi/api.openapi.json', zod: true as const } },
      { tool: 'trivia_contract_drift' as const, arguments: {} },
    ],
  }
  const succeeded = (status: number | string | null | undefined, diagnostics: Diagnostic[]) =>
    mode === 'write' && status === 0 && !diagnostics.some(({ severity }) => severity === 'error')
  if (migration === undefined || generated.status !== 0) {
    return {
      files, written, diagnostics: generated.result.diagnostics, log: clipLog(generated.log),
      ...(succeeded(generated.status, generated.result.diagnostics) && next),
    }
  }

  const migrated = await invoke(['migrate', migration, ...shared], root, 300_000)
  const diagnostics = [...generated.result.diagnostics, ...migrated.result.diagnostics]
  const log = clipLog([generated.log.trim(), migrated.log.trim()].filter(Boolean).join('\n'))
  if (migrated.status !== 0) return { files, written, diagnostics, log }
  const { migration: file, modelRev, renames = [], settled = [] } = migrated.result
  if (file === undefined || (settled.length > 0 && modelRev === undefined)) {
    throw new ApiError('io_error', 'trivia-dotnet returned an invalid migration result.', { log })
  }
  await clear({ migration: file, ...(modelRev !== undefined && { modelRev }), renames, settled })
  files.push({ path: file, kind: 'scaffold', action: 'create' })
  return { files, written: true, diagnostics, log, renames, ...(succeeded(0, diagnostics) && next) }
}

function configuredSolution(web: string): ReturnType<typeof solutionFromWeb> {
  const bytes = readBytes(web, 'package.json')
  if (bytes === null) return null
  try {
    return solutionFromWeb(web, JSON.parse(bytes.toString('utf8')))
  } catch (error) {
    throw new ApiError('invalid_result', 'Could not read the solution configuration from package.json.', {
      hint: (error as Error).message,
    })
  }
}
