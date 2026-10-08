// @trivia/contract-sync — OpenAPI is the source of truth. hey-api generates typed fetch functions
// and TanStack Query v5 option factories into the user's project; this package adds a static,
// deterministic trivia.manifest.json that indexes resources and operations for the designer.

export type { LoadSpecOptions, LoadedSpec } from './adapters/rest-adapter.js'
export { loadSpec, loadSpecFromFile, loadSpecFromUrl, parseSpecText } from './adapters/rest-adapter.js'
export type { SupabaseSpec, SupabaseSpecOptions } from './adapters/supabase-adapter.js'
export { fetchSupabaseSpec, supabaseHeaders, supabaseRestUrl } from './adapters/supabase-adapter.js'
export { POSTGREST_EXCLUDED_OPERATIONS, detectStyle } from './spec/postgrest.js'
export type { ContractSyncOptions, ContractSyncResult, GeneratedModulePaths } from './codegen/codegen.js'
export { ALLOWED_RUNTIME_IMPORT, runContractSync } from './codegen/codegen.js'
export type { ContractSyncErrorCode } from './errors.js'
export { ContractSyncError } from './errors.js'
export type { GenerateManifestOptions, HeyApiClientPlugin, ImportBase } from './manifest/generator.js'
export { DEFAULT_IMPORT_BASE, generateManifest, heyApiPlugins } from './manifest/generator.js'
export * from './manifest/types.js'
export type { SpecDocument, SpecFlavor } from './spec/spec.js'
export { canonicalJson, schemaHash } from './spec/spec.js'
export type { SyncContractOptions, SyncContractResult } from './sync.js'
export { DEFAULT_MANIFEST_PATH, DEFAULT_OUTPUT_DIR, serializeManifest, syncContract } from './sync.js'
