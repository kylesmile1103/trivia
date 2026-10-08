// Builds trivia.manifest.json from the RAW spec (Swagger 2.0, OpenAPI 3.0 or 3.1) plus the code
// hey-api generated for it. Classification reads the spec (classify.ts); every function and type
// name is read back from the generated files, and anything that can't be matched fails loudly.

import path from 'node:path'

import type ts from 'typescript'

import type { GeneratedCode, OperationFunctions, SdkFunction } from '../codegen/generated-code.js'
import {
  GENERATED_FILES,
  arrayElement,
  bodyType,
  memberType,
  namedType,
  readGeneratedCode,
  responseType,
  successStatuses,
  ZOD_FILE,
} from '../codegen/generated-code.js'
import { ContractSyncError } from '../errors.js'
import { defaultExcludedOperations, detectStyle } from '../spec/postgrest.js'
import type { RawOperation, SchemaInfo } from '../spec/reader.js'
import { SpecReader, fieldType, pagination, summarizeEntity, textOrNull } from '../spec/reader.js'
import type { SpecDocument } from '../spec/spec.js'
import { isObject, schemaHash } from '../spec/spec.js'
import { contractSyncVersion, heyApiVersion } from '../versions.js'
import type { Candidate, Classified, Group } from './classify.js'
import { classifyPostgrest, classifyRest, collectGroups, resourceName, restPrimaryKey } from './classify.js'
import type {
  ApiStyle,
  CrudKind,
  HttpMethodUpper,
  ManifestCreateOperation,
  ManifestCustomOperation,
  ManifestEntity,
  ManifestItemOperation,
  ManifestListOperation,
  ManifestModule,
  ManifestModules,
  ManifestPostgrest,
  ManifestResource,
  TriviaManifest,
} from './types.js'
import { MANIFEST_SCHEMA_ID } from './types.js'

export type HeyApiClientPlugin = '@hey-api/client-fetch' | '@hey-api/client-next'

export const DEFAULT_CLIENT: HeyApiClientPlugin = '@hey-api/client-fetch'

/** The plugin list handed to hey-api, in order. */
export function heyApiPlugins(client: HeyApiClientPlugin = DEFAULT_CLIENT, { zod = false }: { zod?: boolean } = {}): string[] {
  return [client, '@hey-api/typescript', '@hey-api/sdk', ...(zod ? ['zod'] : []), '@tanstack/react-query']
}

/** Maps an import alias to a project directory: `{ alias: '@/', dir: 'src' }` means `@/x` ↔ `src/x`. */
export interface ImportBase {
  alias: string
  dir: string
}

export const DEFAULT_IMPORT_BASE: ImportBase = { alias: '@/', dir: 'src' }

export interface GenerateManifestOptions {
  /** Where the spec came from: a path (made project-relative) or a URL (query string dropped). */
  schemaSource: string
  /** Directory the generated code lives in (absolute, or relative to `projectRoot`). */
  generatedDir: string
  /** Import alias used to compute import paths; `false` records `importPath: null`. */
  importBase?: ImportBase | false
  /** Project root that paths in the manifest are relative to. Default: process.cwd(). */
  projectRoot?: string
  /** Force the classification style; detected from the spec when omitted. */
  style?: ApiStyle
  /**
   * `"METHOD /path"` keys that were excluded from codegen; they are skipped here too.
   * Default: none for REST, `["GET /"]` for PostgREST (the same default codegen uses).
   */
  excludeOperations?: readonly string[]
  /** Recorded in `generator.plugins`. */
  client?: HeyApiClientPlugin
  /** Read the generated files from here instead of `generatedDir` (used while staging). */
  readGeneratedFrom?: string
}

// ---------------------------------------------------------------------------------------------
// Reconciliation with the generated code

interface Context {
  reader: SpecReader
  code: GeneratedCode
  style: ApiStyle
  /** SDK functions and hooks claimed by some manifest operation (for the completeness check). */
  usedSdk: Set<string>
  usedHooks: Set<string>
}

function reconcileFunctions(code: GeneratedCode, raw: RawOperation): { sdk: SdkFunction; fns: OperationFunctions } {
  const method = raw.method.toUpperCase()
  const sdk = code.sdkFor(method, raw.path)
  if (!sdk) {
    throw new ContractSyncError(
      'reconcile_failed',
      `hey-api generated no SDK function for ${method} ${raw.path} (looked in ${GENERATED_FILES.sdk})`,
      { hint: 'The generated code does not match this spec; re-run codegen for the same input.' },
    )
  }
  return { sdk, fns: code.functionsFor(sdk.name) }
}

/**
 * The zod.gen.ts export validating an operation's body: hey-api's zod plugin names it after the
 * SDK function (`createCustomer` → `zCreateCustomerBody`). Read back, never assumed: a body
 * without that export is a mismatch with the generated code.
 */
function zodBody(code: GeneratedCode, sdkFn: string, raw: RawOperation): string | null {
  if (code.zodExports === null) return null
  const name = `z${sdkFn.charAt(0).toUpperCase()}${sdkFn.slice(1)}Body`
  if (!code.zodExports.has(name)) {
    throw new ContractSyncError('reconcile_failed', `${ZOD_FILE} exports no ${name} for the body of ${raw.method.toUpperCase()} ${raw.path}`, {
      hint: 'The generated code does not match this spec; re-run codegen for the same input.',
    })
  }
  return name
}

function requireFn(value: string | null, what: string, raw: RawOperation): string {
  if (value === null) {
    throw new ContractSyncError(
      'reconcile_failed',
      `${GENERATED_FILES.queries} exports no ${what} for ${raw.method.toUpperCase()} ${raw.path}`,
    )
  }
  return value
}

/** Fields every operation kind shares, with function names taken from the generated code. */
function baseOperation(context: Context, candidate: Candidate, kind: CrudKind | 'custom') {
  const { sdk, fns } = reconcileFunctions(context.code, candidate.raw)
  context.usedSdk.add(sdk.name)
  for (const fn of Object.values(fns)) if (fn !== null && fn !== sdk.name) context.usedHooks.add(fn)
  return {
    sdk,
    fields: {
      kind,
      method: candidate.raw.method.toUpperCase() as HttpMethodUpper,
      path: candidate.raw.path,
      operationId: textOrNull(candidate.raw.operation['operationId']),
      summary: textOrNull(candidate.raw.operation['summary']),
      style: context.style,
      sdkFn: fns.sdkFn,
      queryOptionsFn: fns.queryOptionsFn,
      queryKeyFn: fns.queryKeyFn,
      infiniteQueryOptionsFn: fns.infiniteQueryOptionsFn,
      infiniteQueryKeyFn: fns.infiniteQueryKeyFn,
      mutationFn: fns.mutationFn,
      parameters: candidate.parameters,
      requestBody: candidate.body ? { ...candidate.body.summary, zodSchema: zodBody(context.code, sdk.name, candidate.raw) } : null,
      response: candidate.response?.summary ?? null,
    },
  }
}

function postgrestDetails(reader: SpecReader, candidate: Candidate, kind: CrudKind, primaryKey: string | null): ManifestPostgrest {
  const prefers = candidate.raw.parameters.filter((p) => p['in'] === 'header' && p['name'] === 'Prefer')
  const declaresRepresentation = prefers.some((p) => Array.isArray(p['enum']) && p['enum'].includes('return=representation'))
  const produces = Array.isArray(reader.spec['produces']) ? reader.spec['produces'] : []
  const rowScoped = kind === 'get' || kind === 'update' || kind === 'delete'
  const writes = kind === 'create' || kind === 'update' || kind === 'delete'
  return {
    rowFilter: rowScoped && primaryKey !== null ? { param: primaryKey, template: 'eq.{value}' } : null,
    singleObjectAccept:
      kind === 'get' && produces.includes('application/vnd.pgrst.object+json') ? 'application/vnd.pgrst.object+json' : null,
    returnRepresentation: writes && declaresRepresentation ? 'return=representation' : null,
    filterRequired: kind === 'update' || kind === 'delete',
  }
}

/**
 * The list operation. The binder writes `data?.<listItemsPath> ?? []`, and `data` is typed as
 * the union of every 2xx response hey-api generated, so each member must have the rows there or
 * the binding wouldn't type-check in the user's project.
 */
function buildList(
  context: Context,
  candidate: Candidate,
  classified: Classified,
  postgrest: ManifestPostgrest | null,
): { operation: ManifestListOperation; itemType: ts.TypeNode | null } {
  const { sdk, fields } = baseOperation(context, candidate, 'list')
  const shape = classified.listShape
  if (!shape) throw new ContractSyncError('reconcile_failed', `List ${fields.path} has no detected shape`)
  requireFn(fields.queryOptionsFn, 'queryOptions factory', candidate.raw)
  const { code } = context
  const rowsAt = (status: string): ts.TypeNode | null => {
    const generated = responseType(code, sdk, status)
    if (generated === null) return null
    const rows = shape.listItemsPath === null ? generated : memberType(code, generated, shape.listItemsPath)
    return rows === null ? null : arrayElement(code, rows)
  }
  const statuses = successStatuses(code, sdk)
  const broken = statuses.length === 0 ? ['(none)'] : statuses.filter((status) => rowsAt(status) === null)
  if (broken.length > 0) {
    const where = shape.listItemsPath === null ? 'the top level' : `"${shape.listItemsPath}"`
    throw new ContractSyncError(
      'reconcile_failed',
      `${fields.method} ${fields.path} lists rows at ${where}, but ${sdk.responsesType ?? sdk.name} in ${GENERATED_FILES.types} has no such array for status ${broken.join(', ')}`,
      { hint: 'Every 2xx response of a list operation needs the same body schema; a body-less 2xx makes the data type unknown.' },
    )
  }
  return {
    operation: {
      ...fields,
      kind: 'list',
      listItemsPath: shape.listItemsPath,
      pagination: pagination(fields.parameters, shape),
      postgrest,
    },
    itemType: rowsAt(fields.response?.status ?? '200'),
  }
}

/** The type types.gen.ts exports for the entity, read through the operation it came from. */
function entityTypeName(
  context: Context,
  slots: Classified['slots'],
  entitySchema: SchemaInfo,
  listItemType: ts.TypeNode | null,
  listItem: SchemaInfo | null,
): string | null {
  const { code, style } = context
  if (listItem !== null && entitySchema === listItem) return namedType(code, listItemType)
  const responder =
    (style !== 'postgrest' && slots.get && entitySchema === slots.get.response?.schema && slots.get) ||
    (slots.create && entitySchema === slots.create.response?.schema && slots.create) ||
    (slots.update && entitySchema === slots.update.response?.schema && slots.update) ||
    null
  if (responder) {
    const { sdk } = reconcileFunctions(code, responder.raw)
    return namedType(code, responseType(code, sdk, responder.response?.summary.status ?? '200'))
  }
  if (slots.create && entitySchema === slots.create.body?.schema) {
    const { sdk } = reconcileFunctions(code, slots.create.raw)
    return namedType(code, bodyType(code, sdk))
  }
  return null
}

function buildResource(context: Context, group: Group): ManifestResource {
  const { reader, style } = context
  const classified = style === 'postgrest' ? classifyPostgrest(reader, group.members) : classifyRest(reader, group.members)
  const { slots } = classified

  // Entity: the single-item read (REST), else the list item, else what writes return or accept.
  const entitySchema =
    (style !== 'postgrest' && slots.get ? slots.get.response?.schema : null) ??
    classified.listShape?.item ??
    slots.create?.response?.schema ??
    slots.update?.response?.schema ??
    slots.create?.body?.schema ??
    null
  const entity: ManifestEntity | null =
    entitySchema !== null && fieldType(entitySchema.node) === 'object' ? summarizeEntity(reader, entitySchema, style) : null

  const primaryKey = style === 'postgrest' ? classified.specPrimaryKey : restPrimaryKey(entity, classified.idParam)
  const postgrest = (candidate: Candidate, kind: CrudKind): ManifestPostgrest | null =>
    style === 'postgrest' ? postgrestDetails(reader, candidate, kind, primaryKey) : null

  const list = slots.list ? buildList(context, slots.list, classified, postgrest(slots.list, 'list')) : null

  const item = (candidate: Candidate | null, kind: 'get' | 'update' | 'delete'): ManifestItemOperation | null => {
    if (!candidate) return null
    const { fields } = baseOperation(context, candidate, kind)
    if (kind === 'get') requireFn(fields.queryOptionsFn, 'queryOptions factory', candidate.raw)
    else requireFn(fields.mutationFn, 'mutation factory', candidate.raw)
    if (classified.idParam === null) {
      throw new ContractSyncError('reconcile_failed', `${fields.method} ${fields.path} has no id parameter`)
    }
    return { ...fields, kind, idParam: classified.idParam, postgrest: postgrest(candidate, kind) }
  }

  let create: ManifestCreateOperation | null = null
  if (slots.create) {
    const { fields } = baseOperation(context, slots.create, 'create')
    requireFn(fields.mutationFn, 'mutation factory', slots.create.raw)
    create = { ...fields, kind: 'create', postgrest: postgrest(slots.create, 'create') }
  }

  const customOperations: ManifestCustomOperation[] = classified.custom
    .map((candidate) => ({ ...baseOperation(context, candidate, 'custom').fields, kind: 'custom' as const }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0))

  if (entity && entitySchema) {
    entity.typeName = entityTypeName(context, slots, entitySchema, list?.itemType ?? null, classified.listShape?.item ?? null)
    if (entity.schemaRef !== null && entity.typeName === null) {
      throw new ContractSyncError(
        'reconcile_failed',
        `No type in ${GENERATED_FILES.types} corresponds to the entity schema ${entity.schemaRef}`,
      )
    }
  }

  return {
    name: resourceName(group, entity),
    groupedBy: group.groupedBy,
    tag: group.tag,
    style,
    basePath: classified.basePath,
    itemPath: classified.itemPath,
    primaryKey,
    entity,
    operations: {
      list: list?.operation ?? null,
      get: item(slots.get, 'get'),
      create,
      update: item(slots.update, 'update'),
      delete: item(slots.delete, 'delete'),
    },
    customOperations,
  }
}

/** Every generated SDK function and hook must belong to some operation, and names must be unique. */
function assertComplete(context: Context, resources: readonly ManifestResource[]): void {
  const unmatchedSdk = [...context.code.sdkFunctions.keys()].filter((name) => !context.usedSdk.has(name)).sort()
  if (unmatchedSdk.length > 0) {
    throw new ContractSyncError(
      'reconcile_failed',
      `Generated SDK functions with no operation in the spec: ${unmatchedSdk.join(', ')}`,
      { hint: 'The generated code is out of date or was produced with different exclusions; re-run codegen.' },
    )
  }
  const unmatchedHooks = [...context.code.hookExports()].filter((name) => !context.usedHooks.has(name)).sort()
  if (unmatchedHooks.length > 0) {
    throw new ContractSyncError(
      'reconcile_failed',
      `Generated TanStack Query exports the manifest does not account for: ${unmatchedHooks.join(', ')}`,
    )
  }
  for (let index = 1; index < resources.length; index++) {
    const previous = resources[index - 1]
    const current = resources[index]
    if (previous && current && previous.name === current.name) {
      throw new ContractSyncError(
        'classification_conflict',
        `Two operation groups both resolve to the resource name "${current.name}" (${previous.basePath ?? previous.tag ?? '?'} and ${current.basePath ?? current.tag ?? '?'})`,
        { hint: 'Add x-trivia-resource to the operations of one of them to name it explicitly.' },
      )
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Modules and source

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

function moduleEntry(projectRoot: string, outputDir: string, file: string, importBase: ImportBase | false): ManifestModule {
  const relativeFile = toPosix(path.relative(projectRoot, path.join(outputDir, file)))
  if (importBase === false) return { file: relativeFile, importPath: null }
  const baseDir = toPosix(path.normalize(importBase.dir)).replace(/\/$/, '')
  const withoutExt = relativeFile.replace(/\.ts$/, '').replace(/\/index$/, '')
  if (!withoutExt.startsWith(`${baseDir}/`)) return { file: relativeFile, importPath: null }
  return { file: relativeFile, importPath: `${importBase.alias}${withoutExt.slice(baseDir.length + 1)}` }
}

function modules(projectRoot: string, outputDir: string, importBase: ImportBase | false, zod: boolean): ManifestModules {
  return {
    outputDir: toPosix(path.relative(projectRoot, outputDir)) || '.',
    queries: moduleEntry(projectRoot, outputDir, GENERATED_FILES.queries, importBase),
    sdk: moduleEntry(projectRoot, outputDir, GENERATED_FILES.sdk, importBase),
    types: moduleEntry(projectRoot, outputDir, GENERATED_FILES.types, importBase),
    client: moduleEntry(projectRoot, outputDir, GENERATED_FILES.client, importBase),
    index: moduleEntry(projectRoot, outputDir, GENERATED_FILES.index, importBase),
    zod: zod ? moduleEntry(projectRoot, outputDir, ZOD_FILE, importBase) : null,
  }
}

/** Project-relative POSIX path for files; URLs lose query string and fragment (may hold keys). */
export function normalizeSource(schemaSource: string, projectRoot: string): string {
  if (/^https?:\/\//i.test(schemaSource)) {
    const url = new URL(schemaSource)
    return `${url.origin}${url.pathname}`
  }
  const absolute = path.resolve(projectRoot, schemaSource)
  const relative = path.relative(projectRoot, absolute)
  // Inside the project: a portable relative path. Outside: the absolute path, which is honest
  // but machine-specific (keep the spec in the repo for manifests that are identical everywhere).
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return toPosix(absolute)
  return toPosix(relative)
}

// ---------------------------------------------------------------------------------------------
// Entry point

export function generateManifest(spec: SpecDocument, options: GenerateManifestOptions): TriviaManifest {
  const reader = new SpecReader(spec)
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd())
  const outputDir = path.resolve(projectRoot, options.generatedDir)
  const style = options.style ?? detectStyle(spec)
  const exclude = [...new Set(options.excludeOperations ?? defaultExcludedOperations(style))].sort()
  const importBase = options.importBase === undefined ? DEFAULT_IMPORT_BASE : options.importBase

  // Spec analysis first, so spec errors surface before any mismatch with the generated code.
  const groups = collectGroups(reader, style, new Set(exclude))
  const context: Context = {
    reader,
    code: readGeneratedCode(options.readGeneratedFrom ?? outputDir),
    style,
    usedSdk: new Set(),
    usedHooks: new Set(),
  }
  const resources = groups
    .map((group) => buildResource(context, group))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  assertComplete(context, resources)

  const info = reader.spec['info']
  return {
    $schema: MANIFEST_SCHEMA_ID,
    manifestVersion: 1,
    generator: {
      name: '@trivia/contract-sync',
      version: contractSyncVersion(),
      heyApi: heyApiVersion(),
      plugins: heyApiPlugins(options.client, { zod: context.code.zodExports !== null }),
    },
    source: {
      location: normalizeSource(options.schemaSource, projectRoot),
      format: reader.info.flavor,
      specVersion: reader.info.version,
      title: isObject(info) ? textOrNull(info['title']) : null,
      apiVersion: isObject(info) ? textOrNull(info['version']) : null,
      style,
      excludedOperations: exclude,
    },
    schemaHash: schemaHash(spec),
    modules: modules(projectRoot, outputDir, importBase, context.code.zodExports !== null),
    resources,
  }
}
