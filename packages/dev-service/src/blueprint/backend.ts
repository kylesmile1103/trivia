import { execFile, type ExecFileException } from 'node:child_process'
import fs from 'node:fs'

import { APP_DOC, MODEL_DOC, type Diagnostic } from '@trivia/blueprint'
import { z } from 'zod'

import { ApiError } from '../engine.js'
import { checkedPath } from './paths.js'
import type { BlueprintWorkspace } from './store.js'

interface BackendFile {
  path: string
  kind: 'generated' | 'scaffold'
  action: 'create' | 'update' | 'unchanged' | 'delete' | 'refused'
}

export interface BackendResult {
  files: BackendFile[]
  written: boolean
  diagnostics: Diagnostic[]
  log: string
}

export const backendInput = z.strictObject({
  mode: z.enum(['plan', 'write']),
  migration: z.string().min(1).optional().describe('With mode: write, run this named migration as a separate command after generation.'),
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

export async function runBackend(workspace: BlueprintWorkspace, { mode, migration, force }: BackendRequest): Promise<BackendResult> {
  if (migration !== undefined && (mode !== 'write' || !identifier.test(migration))) {
    throw new ApiError('invalid_op', 'Pass a valid C# migration name with mode: write.')
  }
  if (force && (mode !== 'write' || migration !== undefined)) {
    throw new ApiError('invalid_op', 'Force applies to a backend write without a migration.')
  }

  const root = fs.realpathSync(workspace.root)
  const blueprint = checkedPath(root, workspace.dir)
  // The CLI reads these two documents directly. Apply the service's symlink guard first.
  for (const file of [APP_DOC, MODEL_DOC]) checkedPath(root, `${workspace.dir}/${file}`)
  const shared = ['--blueprint', blueprint, '--root', root]
  const args = migration === undefined
    ? [mode, ...shared, ...(force ? ['--force'] : [])]
    : ['migrate', migration, ...shared]
  const timeout = migration === undefined ? 120_000 : 300_000
  const { error, stdout, stderr } = await execute(TOOL, args, root, timeout)
  const log = clipLog(stderr)

  if (error?.code === 'ENOENT') {
    const sdk = await execute('dotnet', ['--version'], root, 5_000)
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

  const result = decode(stdout, log)
  const files: BackendFile[] = (result.files ?? []).map((file) =>
    status === 2 && file.action !== 'unchanged' ? { ...file, action: 'refused' } : file)
  if (result.migration) files.push({ path: result.migration, kind: 'scaffold', action: 'create' })
  return {
    files, written: mode === 'write' && status === 0 && files.some(({ action }) => action !== 'unchanged'),
    diagnostics: result.diagnostics, log,
  }
}
