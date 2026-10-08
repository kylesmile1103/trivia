// The whole contract-sync pipeline: load the spec → generate code into a staging directory →
// build the manifest against the staged code → swap the code into place → write the manifest.
// Nothing in the project changes unless codegen and reconciliation both succeed.

import fsp from 'node:fs/promises'
import path from 'node:path'

import type { LoadedSpec } from './adapters/rest-adapter.js'
import { loadSpec } from './adapters/rest-adapter.js'
import { fetchSupabaseSpec } from './adapters/supabase-adapter.js'
import { commitStaged, stageGeneratedCode } from './codegen/codegen.js'
import { ContractSyncError } from './errors.js'
import type { HeyApiClientPlugin, ImportBase } from './manifest/generator.js'
import { generateManifest } from './manifest/generator.js'
import type { ApiStyle, TriviaManifest } from './manifest/types.js'
import { defaultExcludedOperations, detectStyle } from './spec/postgrest.js'

export const DEFAULT_OUTPUT_DIR = 'src/api/generated'
export const DEFAULT_MANIFEST_PATH = 'trivia.manifest.json'

export interface SyncContractOptions {
  /** Spec file path or http(s) URL. Exactly one of `input` and `supabase` is required. */
  input?: string
  /** Fetch PostgREST's spec from a Supabase project instead. */
  supabase?: { url: string; key: string }
  /** Default "src/api/generated". */
  outputDir?: string
  /** Default "trivia.manifest.json". */
  manifestPath?: string
  /** Project root; relative paths resolve against it. Default: process.cwd(). */
  cwd?: string
  /** Default `{ alias: '@/', dir: 'src' }`. */
  importBase?: ImportBase | false
  client?: HeyApiClientPlugin
  /** Default: none for REST, `["GET /"]` for PostgREST. */
  excludeOperations?: readonly string[]
  /** Request headers for a URL `input`. */
  headers?: Readonly<Record<string, string>>
  /** Injectable for tests. */
  fetch?: typeof fetch
}

export interface SyncContractResult {
  manifest: TriviaManifest
  manifestPath: string
  outputDir: string
  files: string[]
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  await fsp.writeFile(temporary, content, 'utf8')
  try {
    await fsp.rename(temporary, file)
  } catch (error) {
    await fsp.rm(temporary, { force: true })
    throw error
  }
}

/** Stable JSON text for the manifest (2-space indent, trailing newline). */
export function serializeManifest(manifest: TriviaManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export async function syncContract(options: SyncContractOptions): Promise<SyncContractResult> {
  if ((options.input === undefined) === (options.supabase === undefined)) {
    throw new ContractSyncError('usage', 'Pass exactly one of `input` or `supabase`')
  }
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const outputDir = path.resolve(cwd, options.outputDir ?? DEFAULT_OUTPUT_DIR)
  const manifestPath = path.resolve(cwd, options.manifestPath ?? DEFAULT_MANIFEST_PATH)

  let loaded: LoadedSpec & { style?: ApiStyle; excludeOperations?: readonly string[] }
  if (options.supabase) {
    loaded = await fetchSupabaseSpec({ ...options.supabase, ...(options.fetch ? { fetch: options.fetch } : {}) })
  } else {
    loaded = await loadSpec(options.input as string, {
      cwd,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
  }
  const style = loaded.style ?? detectStyle(loaded.spec)
  const excludeOperations = options.excludeOperations ?? loaded.excludeOperations ?? defaultExcludedOperations(style)

  const staged = await stageGeneratedCode(loaded.spec, {
    outputDir,
    style,
    excludeOperations,
    ...(options.client ? { client: options.client } : {}),
  })
  let manifest: TriviaManifest
  try {
    manifest = generateManifest(loaded.spec, {
      schemaSource: loaded.source,
      generatedDir: outputDir,
      readGeneratedFrom: staged.dir,
      projectRoot: cwd,
      style,
      excludeOperations,
      ...(options.importBase !== undefined ? { importBase: options.importBase } : {}),
      ...(options.client ? { client: options.client } : {}),
    })
    await commitStaged(staged, outputDir)
  } catch (error) {
    await staged.discard()
    throw error
  }
  await writeFileAtomic(manifestPath, serializeManifest(manifest))
  return { manifest, manifestPath, outputDir, files: staged.files }
}
