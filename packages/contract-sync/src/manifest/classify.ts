// Groups a spec's operations into resources and classifies them as list/get/create/update/delete
// or custom. Pure spec analysis: nothing here looks at generated code.
//
// Grouping precedence: x-trivia-resource > tags[0] > first path segment (after api/rest/vN).
// REST: the collection is the base path most CRUD-shaped operations hang off; the item path is
// `<base>/{param}`. PostgREST: there are no item paths; rows are selected with filters on the
// collection path, keyed by the column PostgREST marks `<pk/>`.

import { ContractSyncError } from '../errors.js'
import type { BodyInfo, ListShape, RawOperation, ResponseInfo, SchemaInfo, SpecReader } from '../spec/reader.js'
import { listShape, requestBody, successResponse, summarizeParameter, textOrNull } from '../spec/reader.js'
import { isObject, refName } from '../spec/spec.js'
import { resourceNameFrom, resourceNameFromSchema } from './naming.js'
import type { ApiStyle, CrudKind, ManifestEntity, ManifestParameter, ResourceGrouping } from './types.js'

/** One operation with its parameter, body and response summaries. */
export interface Candidate {
  raw: RawOperation
  parameters: ManifestParameter[]
  body: BodyInfo | null
  response: ResponseInfo | null
}

/** Operations that form one resource. */
export interface Group {
  /** Strongest grouping source among the members. */
  groupedBy: ResourceGrouping
  /** The x-trivia-resource value, when any member sets one. */
  explicitName: string | null
  /** Grouping key of the first member (tag, path segment or x-trivia-resource), for naming. */
  firstKey: string
  tag: string | null
  members: Candidate[]
}

const GROUPING_RANK: Record<ResourceGrouping, number> = { 'x-trivia-resource': 3, tag: 2, path: 1 }

const VERSION_SEGMENT = /^(api|rest|v\d+(\.\d+)*)$/i

/** `x-trivia-resource` values: an identifier the binder can build names from ("Customer"). */
const RESOURCE_NAME = /^[A-Za-z][A-Za-z0-9]*$/

function isParamSegment(segment: string): boolean {
  return /^\{[^}]+\}$/.test(segment)
}

function segments(route: string): string[] {
  return route.split('/').filter((part) => part.length > 0)
}

function pathPrefix(route: string): string {
  return segments(route).find((segment) => !isParamSegment(segment) && !VERSION_SEGMENT.test(segment)) ?? 'root'
}

function grouping(raw: RawOperation, style: ApiStyle): { key: string; by: ResourceGrouping; explicit: boolean } {
  const explicit = raw.operation['x-trivia-resource'] ?? raw.pathItem['x-trivia-resource']
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !RESOURCE_NAME.test(explicit)) {
      throw new ContractSyncError(
        'input_invalid',
        `x-trivia-resource on ${raw.method.toUpperCase()} ${raw.path} must be an identifier like "Customer", got ${JSON.stringify(explicit)}`,
      )
    }
    return { key: explicit, by: 'x-trivia-resource', explicit: true }
  }
  // PostgREST tags functions "(rpc) <name>"; they share one RPC namespace, not a table.
  if (style === 'postgrest' && raw.path.startsWith('/rpc/')) return { key: 'rpc', by: 'path', explicit: false }
  const tags = raw.operation['tags']
  const tag = Array.isArray(tags) ? textOrNull(tags[0]) : null
  if (tag !== null) return { key: tag, by: 'tag', explicit: false }
  return { key: pathPrefix(raw.path), by: 'path', explicit: false }
}

const KEY_SUFFIX = /[-_\s]*(controller|endpoints?|api|service)$/i

function nameFromKey(key: string): string {
  const stripped = key.replace(KEY_SUFFIX, '')
  return resourceNameFrom(stripped.length > 0 ? stripped : key)
}

/** Groups whose keys only differ in spelling merge: "Customers" (tag), "customers" (path), "customer-controller". */
function mergeKey(key: string): string {
  return nameFromKey(key).toLowerCase()
}

/** The resource name: explicit > entity schema name > tag/path key. */
export function resourceName(group: Group, entity: ManifestEntity | null): string {
  if (group.explicitName !== null) return group.explicitName.slice(0, 1).toUpperCase() + group.explicitName.slice(1)
  if (entity?.schemaRef) {
    const fromSchema = resourceNameFromSchema(refName(entity.schemaRef))
    if (fromSchema.length > 0) return fromSchema
  }
  const fromKey = nameFromKey(group.firstKey)
  return fromKey.length > 0 ? fromKey : 'Root'
}

export interface Slots {
  list: Candidate | null
  get: Candidate | null
  create: Candidate | null
  update: Candidate | null
  delete: Candidate | null
}

export interface Classified {
  basePath: string | null
  itemPath: string | null
  idParam: string | null
  slots: Slots
  listShape: ListShape | null
  custom: Candidate[]
  /** Primary key the spec states outright (PostgREST's `<pk/>` marker); null when inferred later. */
  specPrimaryKey: string | null
}

export function classifyRest(reader: SpecReader, members: readonly Candidate[]): Classified {
  // Base path = the collection the most CRUD-shaped operations hang off.
  const scores = new Map<string, number>()
  const baseOf = (candidate: Candidate): { base: string; item: boolean } => {
    const parts = segments(candidate.raw.path)
    const last = parts[parts.length - 1]
    if (last !== undefined && isParamSegment(last)) return { base: `/${parts.slice(0, -1).join('/')}`, item: true }
    return { base: candidate.raw.path, item: false }
  }
  const eligible = (candidate: Candidate): boolean => {
    const { item } = baseOf(candidate)
    const { method } = candidate.raw
    if (item) return method === 'get' || method === 'put' || method === 'patch' || method === 'delete'
    if (method === 'post') return true
    return method === 'get' && listShape(reader, candidate.response?.schema ?? null) !== null
  }
  for (const candidate of members) {
    if (!eligible(candidate)) continue
    const { base } = baseOf(candidate)
    scores.set(base, (scores.get(base) ?? 0) + 1)
  }
  const ranked = [...scores.entries()].sort(
    ([a, scoreA], [b, scoreB]) => scoreB - scoreA || segments(a).length - segments(b).length || (a < b ? -1 : a > b ? 1 : 0),
  )
  const basePath = ranked[0]?.[0] ?? null
  const slots: Slots = { list: null, get: null, create: null, update: null, delete: null }
  const custom: Candidate[] = []
  let itemPath: string | null = null
  let shape: ListShape | null = null
  // Item paths under the base, deterministic order (a valid spec has at most one).
  const itemPaths = [
    ...new Set(members.filter((m) => basePath !== null && eligible(m) && baseOf(m).item && baseOf(m).base === basePath).map((m) => m.raw.path)),
  ].sort()
  itemPath = itemPaths[0] ?? null

  for (const candidate of members) {
    const { method, path: route } = candidate.raw
    let slot: CrudKind | null = null
    if (basePath !== null && route === basePath) {
      if (method === 'get') {
        const detected = listShape(reader, candidate.response?.schema ?? null)
        if (detected) {
          slot = 'list'
          shape = detected
        }
      } else if (method === 'post') slot = 'create'
    } else if (itemPath !== null && route === itemPath) {
      if (method === 'get') slot = 'get'
      else if (method === 'put' || method === 'patch') slot = 'update'
      else if (method === 'delete') slot = 'delete'
    }
    if (slot === 'update' && slots.update !== null) {
      // PUT and PATCH both exist: PUT (full replace, matches a full edit form) wins; PATCH is custom.
      if (method === 'put') {
        custom.push(slots.update)
        slots.update = candidate
      } else custom.push(candidate)
      continue
    }
    if (slot === null) custom.push(candidate)
    else slots[slot] = candidate
  }
  const last = itemPath === null ? undefined : segments(itemPath).pop()
  const anyCrud = Object.values(slots).some((slot) => slot !== null)
  return {
    basePath: anyCrud ? basePath : null,
    itemPath: slots.get || slots.update || slots.delete ? itemPath : null,
    idParam: last === undefined ? null : last.slice(1, -1),
    slots,
    listShape: shape,
    custom,
    specPrimaryKey: null,
  }
}

/** Primary-key columns of a PostgREST table definition: the `<pk/>` marker in the description. */
function postgrestPrimaryKey(reader: SpecReader, entity: SchemaInfo | null): string[] {
  if (!entity) return []
  return reader
    .objectShape(entity)
    .properties.filter(([, value]) => isObject(value) && typeof value['description'] === 'string' && value['description'].includes('<pk/>'))
    .map(([name]) => name)
}

export function classifyPostgrest(reader: SpecReader, members: readonly Candidate[]): Classified {
  const slots: Slots = { list: null, get: null, create: null, update: null, delete: null }
  const custom: Candidate[] = []
  const tables = members.filter((m) => segments(m.raw.path).length === 1 && !m.raw.path.startsWith('/rpc/'))
  const basePath = [...new Set(tables.map((m) => m.raw.path))].sort()[0] ?? null
  const read = members.find((m) => m.raw.path === basePath && m.raw.method === 'get')
  const shape = read ? listShape(reader, read.response?.schema ?? null) : null
  const keys = postgrestPrimaryKey(reader, shape?.item ?? null)
  const primaryKey = keys.length === 1 && keys[0] !== undefined ? keys[0] : null
  const filters = (candidate: Candidate): boolean =>
    primaryKey !== null && candidate.parameters.some((p) => p.in === 'query' && p.name === primaryKey)
  for (const candidate of members) {
    const { method, path: route } = candidate.raw
    if (route !== basePath) {
      custom.push(candidate)
      continue
    }
    if (method === 'get' && shape) {
      slots.list = candidate
      // One endpoint, two uses: the same GET with a row filter reads a single row.
      if (filters(candidate)) slots.get = candidate
    } else if (method === 'post') slots.create = candidate
    else if (method === 'patch' && filters(candidate)) slots.update = candidate
    else if (method === 'delete' && filters(candidate)) slots.delete = candidate
    else custom.push(candidate)
  }
  const anyCrud = Object.values(slots).some((slot) => slot !== null)
  return {
    basePath: anyCrud ? basePath : null,
    itemPath: null,
    idParam: primaryKey,
    slots,
    listShape: slots.list ? shape : null,
    custom,
    specPrimaryKey: primaryKey,
  }
}

/** REST primary key: the entity field named like the id parameter, or `id` for `customerId`-style params. */
export function restPrimaryKey(entity: ManifestEntity | null, idParam: string | null): string | null {
  if (!entity || idParam === null) return null
  const names = new Set(entity.fields.map((field) => field.name))
  if (names.has(idParam)) return idParam
  if (/(Id|_id|ID)$/.test(idParam) && names.has('id')) return 'id'
  return null
}

/** Summarizes every operation (minus `exclude`) and groups them into resources, in spec order. */
export function collectGroups(reader: SpecReader, style: ApiStyle, exclude: ReadonlySet<string>): Group[] {
  const groups = new Map<string, Group>()
  for (const raw of reader.operations(exclude)) {
    const candidate: Candidate = {
      raw,
      parameters: raw.parameters
        .map((parameter) => summarizeParameter(reader, parameter))
        .filter((parameter): parameter is ManifestParameter => parameter !== null),
      body: requestBody(reader, raw, style),
      response: successResponse(reader, raw),
    }
    const { key, by, explicit } = grouping(raw, style)
    const tags = raw.operation['tags']
    const tag = Array.isArray(tags) ? textOrNull(tags[0]) : null
    const id = mergeKey(key)
    let group = groups.get(id)
    if (!group) {
      group = { groupedBy: by, explicitName: null, firstKey: key, tag, members: [] }
      groups.set(id, group)
    }
    if (GROUPING_RANK[by] > GROUPING_RANK[group.groupedBy]) group.groupedBy = by
    group.tag ??= tag
    if (explicit) {
      if (group.explicitName !== null && group.explicitName !== key) {
        throw new ContractSyncError(
          'classification_conflict',
          `x-trivia-resource values "${group.explicitName}" and "${key}" name the same resource`,
          { hint: 'Use one spelling for every operation of the resource.' },
        )
      }
      group.explicitName = key
    }
    group.members.push(candidate)
  }
  return [...groups.values()]
}

