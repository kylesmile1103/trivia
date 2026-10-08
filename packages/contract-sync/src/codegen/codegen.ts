// Runs @hey-api/openapi-ts (pinned 0.99.0) to generate the typed fetch client, the SDK and the
// TanStack Query v5 option factories. Generation happens in a staging directory next to the
// output directory; only a complete, verified result replaces the previous output, and a
// directory holding anything hey-api didn't write is never replaced.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@hey-api/openapi-ts'
import type { UserConfig } from '@hey-api/openapi-ts'

import { loadSpec } from '../adapters/rest-adapter.js'
import { ContractSyncError, describeError } from '../errors.js'
import type { HeyApiClientPlugin } from '../manifest/generator.js'
import { DEFAULT_CLIENT, heyApiPlugins } from '../manifest/generator.js'
import type { ApiStyle } from '../manifest/types.js'
import { defaultExcludedOperations, detectStyle, patchPostgrestForCodegen } from '../spec/postgrest.js'
import type { SpecDocument } from '../spec/spec.js'
import { detectSpec, withoutOperations } from '../spec/spec.js'
import { GENERATED_FILES, HEY_API_HEADER, ZOD_FILE, importSpecifiers } from './generated-code.js'

export interface ContractSyncOptions {
  /** Spec file path (JSON or YAML), http(s) URL, or an already-parsed document. */
  input: string | SpecDocument
  /** Directory for the generated code, e.g. "src/api/generated" (relative to `cwd`). */
  outputDir: string
  /** hey-api client plugin. Only clients whose bundle imports no third-party package are allowed. */
  client?: HeyApiClientPlugin
  /** Base for relative `input`/`outputDir`. Default: process.cwd(). */
  cwd?: string
  /**
   * `"METHOD /path"` operation keys to leave out of the generated code.
   * Default: none for REST, `["GET /"]` (the introspection endpoint) for PostgREST.
   */
  excludeOperations?: readonly string[]
  /** Extra request headers when `input` is a URL. */
  headers?: Readonly<Record<string, string>>
  /** Also generate zod schemas (hey-api's zod plugin, zod.gen.ts); the code may then import `zod`. */
  zod?: boolean
}

export interface GeneratedModulePaths {
  queries: string
  sdk: string
  types: string
  client: string
  index: string
}

export interface ContractSyncResult {
  /** Absolute output directory. */
  outputDir: string
  /** Generated files, POSIX paths relative to `outputDir`, sorted. */
  files: string[]
  /** Absolute paths of the modules user code and the manifest refer to. */
  modules: GeneratedModulePaths
  /** The spec that was generated from (as loaded, before hey-api saw a copy). */
  spec: SpecDocument
  /** Where the spec came from: the input string, or "<object>". */
  source: string
}

/** Only these clients bundle without importing a third-party package (verified in 0.99.0 dist/clients). */
const RUNTIME_FREE_CLIENTS: ReadonlySet<string> = new Set<HeyApiClientPlugin>(['@hey-api/client-fetch', '@hey-api/client-next'])

/** The only non-relative import generated code may contain (plus `zod` for zod.gen.ts). */
export const ALLOWED_RUNTIME_IMPORT = '@tanstack/react-query'
const ZOD_IMPORT = 'zod'

/**
 * hey-api loads `openapi-ts.config.*` from process.cwd() and deep-merges it into programmatic
 * options, so a config file in the user's project would change our output. Pointing `configFile`
 * at an empty config we ship stops that discovery.
 */
const ISOLATED_CONFIG = fileURLToPath(new URL('../config/openapi-ts.isolated.json', import.meta.url))

function assertIsolatedEnvironment(): void {
  if (process.env['HEY_API_DUMP_REGISTRY']) {
    throw new ContractSyncError(
      'environment',
      'HEY_API_DUMP_REGISTRY is set; hey-api would add registry-dump.json to the generated output',
      { hint: 'Unset HEY_API_DUMP_REGISTRY for contract sync.' },
    )
  }
  // c12 still reads an rc file from the working directory even when configFile is set.
  const rcFile = path.join(process.cwd(), '.openapi-tsrc')
  if (fs.existsSync(rcFile)) {
    throw new ContractSyncError('environment', `${rcFile} would be merged into hey-api's configuration`, {
      hint: 'Remove it, or run contract sync from a directory without one.',
    })
  }
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(absolute, base)))
    else files.push(path.relative(base, absolute).split(path.sep).join('/'))
  }
  return files.sort()
}

async function firstLine(file: string): Promise<string> {
  const handle = await fsp.open(file, 'r')
  try {
    const buffer = Buffer.alloc(HEY_API_HEADER.length + 2)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0] ?? ''
  } finally {
    await handle.close()
  }
}

/** Files in an existing output directory that hey-api didn't write (POSIX, relative). */
async function foreignFiles(dir: string): Promise<string[]> {
  const foreign: string[] = []
  for (const file of await listFiles(dir)) {
    if (!file.endsWith('.ts') || (await firstLine(path.join(dir, file))) !== HEY_API_HEADER) foreign.push(file)
  }
  return foreign
}

async function assertReplaceable(outputDir: string): Promise<void> {
  let stat: fs.Stats
  try {
    stat = await fsp.lstat(outputDir)
  } catch {
    return // does not exist yet
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ContractSyncError('unsafe_output_dir', `${outputDir} exists and is not a plain directory`, {
      hint: 'Choose an output directory that is empty or only holds previously generated code.',
    })
  }
  const foreign = await foreignFiles(outputDir)
  if (foreign.length > 0) {
    const shown = foreign.slice(0, 10).join(', ') + (foreign.length > 10 ? `, … (${foreign.length} files)` : '')
    throw new ContractSyncError(
      'unsafe_output_dir',
      `Refusing to replace ${outputDir}: it contains files @hey-api/openapi-ts did not generate (${shown})`,
      { hint: 'Move those files elsewhere, or pass an output directory used only for generated code.' },
    )
  }
}

/**
 * Fails when generated code imports anything but relative modules and @tanstack/react-query
 * (and, with `zod`, the zod package from zod.gen.ts).
 */
export async function assertRuntimeIndependent(dir: string, files: readonly string[], { zod = false }: { zod?: boolean } = {}): Promise<void> {
  const violations: string[] = []
  for (const file of files) {
    if (!file.endsWith('.ts')) continue
    const text = await fsp.readFile(path.join(dir, file), 'utf8')
    for (const specifier of importSpecifiers(text)) {
      const allowed = specifier === ALLOWED_RUNTIME_IMPORT || (zod && file === ZOD_FILE && specifier === ZOD_IMPORT)
      if (!specifier.startsWith('./') && !specifier.startsWith('../') && !allowed) {
        violations.push(`${file} imports "${specifier}"`)
      }
    }
  }
  if (violations.length > 0) {
    throw new ContractSyncError('runtime_dependency', `Generated code depends on runtime packages: ${violations.join('; ')}`, {
      hint: `Trivia's generated code may only import ${ALLOWED_RUNTIME_IMPORT}${zod ? ' (and zod, from its zod schemas)' : ''}.`,
    })
  }
}

export interface StagedCode {
  /** Absolute staging directory (a sibling of the output directory). */
  dir: string
  files: string[]
  discard(): Promise<void>
}

/** Generates into a fresh staging directory and verifies the result. Caller commits or discards. */
export async function stageGeneratedCode(
  spec: SpecDocument,
  options: {
    outputDir: string
    client?: HeyApiClientPlugin
    style?: ApiStyle
    excludeOperations?: readonly string[]
    zod?: boolean
  },
): Promise<StagedCode> {
  detectSpec(spec)
  const client = options.client ?? DEFAULT_CLIENT
  if (!RUNTIME_FREE_CLIENTS.has(client)) {
    throw new ContractSyncError('usage', `Client "${String(client)}" is not supported`, {
      hint: `Use one of ${[...RUNTIME_FREE_CLIENTS].join(', ')}; other hey-api clients make generated code import a runtime package.`,
    })
  }
  assertIsolatedEnvironment()
  await assertReplaceable(options.outputDir)

  // hey-api gets a copy: it bundles and patches its input in place, and the caller's spec (hence
  // the manifest and its hash) must stay exactly what was loaded. Excluded operations are removed
  // from the copy, and PostgREST's schema-less 206 responses get their 200 schema.
  const style = options.style ?? detectStyle(spec)
  const exclude = [...new Set(options.excludeOperations ?? defaultExcludedOperations(style))].sort()
  const input = withoutOperations(spec, exclude)
  if (style === 'postgrest') patchPostgrestForCodegen(input)

  const parent = path.dirname(options.outputDir)
  await fsp.mkdir(parent, { recursive: true })
  const dir = await fsp.mkdtemp(path.join(parent, `.${path.basename(options.outputDir)}.staging-`))
  const discard = (): Promise<void> => fsp.rm(dir, { recursive: true, force: true })

  const config: UserConfig = {
    configFile: ISOLATED_CONFIG,
    input: input as UserConfig['input'],
    interactive: false,
    logs: { file: false, level: 'silent' },
    output: { clean: false, path: dir, postProcess: [], tsConfigPath: null },
    plugins: heyApiPlugins(client, { zod: options.zod ?? false }) as NonNullable<UserConfig['plugins']>,
  }

  try {
    let contexts: ReadonlyArray<unknown>
    try {
      contexts = await createClient(config)
    } catch (error) {
      throw new ContractSyncError('codegen_failed', `@hey-api/openapi-ts failed: ${describeError(error)}`, { cause: error })
    }
    // With silent logs hey-api reports input errors by returning no context instead of throwing.
    if (contexts.length !== 1) {
      throw new ContractSyncError('codegen_failed', `@hey-api/openapi-ts produced ${contexts.length} jobs; expected 1`, {
        hint: 'The input could not be read or parsed by hey-api.',
      })
    }
    const files = await listFiles(dir)
    const expected = [...Object.values(GENERATED_FILES), ...(options.zod ? [ZOD_FILE] : [])]
    const missing = expected.filter((file) => !files.includes(file))
    if (missing.length > 0) {
      throw new ContractSyncError('codegen_failed', `hey-api did not generate ${missing.join(', ')}`, {
        hint: 'A spec without operations produces no TanStack Query factories.',
      })
    }
    await assertRuntimeIndependent(dir, files, { zod: options.zod ?? false })
    return { dir, files, discard }
  } catch (error) {
    await discard()
    throw error
  }
}

/**
 * Moves the staged directory into place with two renames in the same parent directory (old
 * output aside, staged output in), so the output is never half-written. If the second rename
 * fails, the old output is moved back; if even that fails, the error says where it is.
 */
export async function commitStaged(staged: StagedCode, outputDir: string): Promise<void> {
  await assertReplaceable(outputDir)
  const previous = `${staged.dir}.previous`
  const hadPrevious = fs.existsSync(outputDir)
  if (hadPrevious) await fsp.rename(outputDir, previous)
  try {
    await fsp.rename(staged.dir, outputDir)
  } catch (error) {
    let restored = !hadPrevious
    if (hadPrevious) {
      restored = await fsp.rename(previous, outputDir).then(
        () => true,
        () => false,
      )
    }
    throw new ContractSyncError(
      'codegen_failed',
      `Could not move generated code into ${outputDir}: ${describeError(error)}` +
        (restored ? '' : `; the previous output is still at ${previous}`),
      { cause: error },
    )
  }
  if (hadPrevious) await fsp.rm(previous, { recursive: true, force: true })
}

export function modulePaths(outputDir: string): GeneratedModulePaths {
  return {
    queries: path.join(outputDir, GENERATED_FILES.queries),
    sdk: path.join(outputDir, GENERATED_FILES.sdk),
    types: path.join(outputDir, GENERATED_FILES.types),
    client: path.join(outputDir, GENERATED_FILES.client),
    index: path.join(outputDir, GENERATED_FILES.index),
  }
}

/**
 * Generates typed client code for `input` into `outputDir`:
 * `types.gen.ts`, `sdk.gen.ts`, `client.gen.ts` + bundled `client/` and `core/`,
 * `@tanstack/react-query.gen.ts` and `index.ts`. Deterministic: same input → same bytes.
 */
export async function runContractSync(options: ContractSyncOptions): Promise<ContractSyncResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const loaded =
    typeof options.input === 'string'
      ? await loadSpec(options.input, { cwd, ...(options.headers ? { headers: options.headers } : {}) })
      : { spec: options.input, source: '<object>' }
  const outputDir = path.resolve(cwd, options.outputDir)
  const staged = await stageGeneratedCode(loaded.spec, {
    outputDir,
    ...(options.client ? { client: options.client } : {}),
    ...(options.excludeOperations ? { excludeOperations: options.excludeOperations } : {}),
    ...(options.zod ? { zod: true } : {}),
  })
  try {
    await commitStaged(staged, outputDir)
  } catch (error) {
    await staged.discard()
    throw error
  }
  return { outputDir, files: staged.files, modules: modulePaths(outputDir), spec: loaded.spec, source: loaded.source }
}
