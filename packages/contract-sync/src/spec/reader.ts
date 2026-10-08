// Reads the RAW spec for the manifest: operations, parameters, request/response bodies, schemas
// and list shapes, across Swagger 2.0 (definitions, `in: body`, response `schema`) and OpenAPI
// 3.0/3.1 (components, `requestBody`, response `content`). Every access is checked; `$ref`s are
// resolved one hop at a time, so recursive schemas are safe.

import { ContractSyncError } from '../errors.js'
import type {
  ApiStyle,
  EnumValue,
  FieldType,
  ManifestEntity,
  ManifestField,
  ManifestFieldItems,
  ManifestPagination,
  ManifestParameter,
  ManifestRequestBody,
  ManifestResponse,
} from '../manifest/types.js'
import type { HttpMethod, JsonObject, SpecDocument, SpecInfo } from './spec.js'
import { HTTP_METHODS, RefResolver, asString, detectSpec, isObject } from './spec.js'

// ---------------------------------------------------------------------------------------------
// Raw spec access

export interface RawOperation {
  method: HttpMethod
  path: string
  operation: JsonObject
  pathItem: JsonObject
  /** Path-level and operation-level parameters, resolved and merged (operation wins). */
  parameters: JsonObject[]
}

export interface SchemaInfo {
  /** The schema after following `$ref`s and unwrapping `allOf: [$ref]` / nullable unions. */
  node: JsonObject
  /** The most specific named definition seen on the way. */
  ref: string | null
  nullable: boolean
}

export class SpecReader {
  readonly spec: SpecDocument
  readonly info: SpecInfo
  readonly refs: RefResolver

  constructor(spec: SpecDocument) {
    this.spec = spec
    this.info = detectSpec(spec)
    this.refs = new RefResolver(spec)
  }

  get isSwagger2(): boolean {
    return this.info.flavor === 'swagger-2.0'
  }

  operations(exclude: ReadonlySet<string>): RawOperation[] {
    const paths = this.spec['paths']
    if (!isObject(paths)) {
      throw new ContractSyncError('input_invalid', 'The spec has no "paths" object')
    }
    const result: RawOperation[] = []
    for (const route of Object.keys(paths)) {
      const pathItem = this.refs.resolve(paths[route])?.node
      if (!pathItem) continue
      const shared = Array.isArray(pathItem['parameters']) ? pathItem['parameters'] : []
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method]
        if (!isObject(operation)) continue
        if (exclude.has(`${method.toUpperCase()} ${route}`)) continue
        const own = Array.isArray(operation['parameters']) ? operation['parameters'] : []
        result.push({ method, path: route, operation, pathItem, parameters: this.mergeParameters(shared, own) })
      }
    }
    return result
  }

  private mergeParameters(shared: readonly unknown[], own: readonly unknown[]): JsonObject[] {
    const merged = new Map<string, JsonObject>()
    for (const entry of [...shared, ...own]) {
      const parameter = this.refs.resolve(entry)?.node
      if (!parameter) continue
      const name = asString(parameter['name'])
      const location = asString(parameter['in'])
      if (name === undefined || location === undefined) {
        throw new ContractSyncError('input_invalid', 'A parameter is missing its "name" or "in" field')
      }
      merged.set(`${location}:${name}`, parameter)
    }
    return [...merged.values()]
  }

  /** Follows refs, unwraps `allOf: [one]` and `anyOf/oneOf: [X, null]`, and reports nullability. */
  schema(value: unknown): SchemaInfo | null {
    const resolved = this.refs.resolve(value)
    if (!resolved) return null
    let { node } = resolved
    let ref = resolved.ref ?? null
    let nullable = isNullable(node)
    for (let hops = 0; hops < 32; hops++) {
      const allOf = node['allOf']
      const union = Array.isArray(node['anyOf']) ? node['anyOf'] : Array.isArray(node['oneOf']) ? node['oneOf'] : null
      let next: unknown
      if (Array.isArray(allOf) && allOf.length === 1 && !isObject(node['properties'])) {
        next = allOf[0]
      } else if (union) {
        const members = union.filter((member) => !(isObject(member) && member['type'] === 'null'))
        if (members.length !== union.length) nullable = true
        if (members.length === 1) next = members[0]
      }
      if (next === undefined) break
      const inner = this.refs.resolve(next)
      if (!inner) break
      node = inner.node
      ref = inner.ref ?? ref
      nullable ||= isNullable(node)
    }
    return { node, ref, nullable }
  }

  /** Properties and required names of an object schema, with allOf members merged (cycle-safe). */
  objectShape(info: SchemaInfo): { properties: Array<[string, unknown]>; required: Set<string> } {
    const properties = new Map<string, unknown>()
    const required = new Set<string>()
    const seen = new Set<JsonObject>()
    const visit = (node: JsonObject): void => {
      if (seen.has(node)) return
      seen.add(node)
      const allOf = node['allOf']
      if (Array.isArray(allOf)) {
        for (const member of allOf) {
          const resolved = this.schema(member)
          if (resolved) visit(resolved.node)
        }
      }
      const own = node['properties']
      if (isObject(own)) for (const key of Object.keys(own)) properties.set(key, own[key])
      if (Array.isArray(node['required'])) {
        for (const name of node['required']) if (typeof name === 'string') required.add(name)
      }
    }
    visit(info.node)
    return { properties: [...properties.entries()], required }
  }

  /** Picks the JSON-ish entry of a 3.x `content` map. */
  pickContent(content: unknown): { contentType: string; schema: unknown } | null {
    if (!isObject(content)) return null
    const types = Object.keys(content)
    const contentType =
      types.find((type) => type === 'application/json') ??
      types.find((type) => /[/+]json(;|$)/.test(type)) ??
      types[0]
    if (contentType === undefined) return null
    const media = content[contentType]
    return { contentType, schema: isObject(media) ? media['schema'] : undefined }
  }

  /** JSON-ish media type from a 2.0 `produces`/`consumes` list (operation, then spec level). */
  pickMediaType(operation: JsonObject, field: 'produces' | 'consumes'): string | null {
    const list = Array.isArray(operation[field]) ? operation[field] : this.spec[field]
    const types = Array.isArray(list) ? list.filter((type): type is string => typeof type === 'string') : []
    return (
      types.find((type) => type === 'application/json') ??
      types.find((type) => /[/+]json(;|$)/.test(type)) ??
      types[0] ??
      'application/json'
    )
  }
}

function isNullable(node: JsonObject): boolean {
  const type = node['type']
  return (
    node['nullable'] === true ||
    node['x-nullable'] === true ||
    (Array.isArray(type) && type.includes('null')) ||
    (Array.isArray(node['enum']) && node['enum'].includes(null))
  )
}

const FIELD_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array'])

export function fieldType(node: JsonObject): FieldType {
  const raw = node['type']
  const declared = (Array.isArray(raw) ? raw : [raw]).filter(
    (type): type is string => typeof type === 'string' && type !== 'null',
  )
  if (declared.length === 1 && declared[0] !== undefined && FIELD_TYPES.has(declared[0])) {
    return declared[0] as FieldType
  }
  if (declared.length > 1) return 'unknown'
  if (isObject(node['properties']) || Array.isArray(node['allOf'])) return 'object'
  if (node['items'] !== undefined) return 'array'
  const values = Array.isArray(node['enum']) ? node['enum'].filter((value) => value !== null) : []
  if (values.length > 0 && values.every((value) => typeof value === 'string')) return 'string'
  if (values.length > 0 && values.every((value) => typeof value === 'number')) {
    return values.every((value) => Number.isInteger(value)) ? 'integer' : 'number'
  }
  return 'unknown'
}

function enumValues(node: JsonObject): EnumValue[] | null {
  const values = node['enum']
  if (!Array.isArray(values)) return null
  return values.filter(
    (value): value is EnumValue =>
      value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  )
}

export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// ---------------------------------------------------------------------------------------------
// Summaries (parameters, bodies, responses, fields)

export function summarizeParameter(reader: SpecReader, parameter: JsonObject): ManifestParameter | null {
  const location = parameter['in']
  if (location !== 'path' && location !== 'query' && location !== 'header' && location !== 'cookie') return null
  const name = asString(parameter['name']) ?? ''
  // Swagger 2.0 keeps type/format/enum on the parameter; 3.x nests them under `schema`.
  const schema = reader.isSwagger2 ? { node: parameter } : reader.schema(parameter['schema'])
  const node = schema?.node ?? {}
  const summary: ManifestParameter = {
    name,
    in: location,
    required: parameter['required'] === true || location === 'path',
    type: fieldType(node),
    format: textOrNull(node['format']),
    enum: enumValues(node),
  }
  const own = reader.isSwagger2 ? parameter : parameter['schema']
  const declaredDefault = isObject(own) && own['default'] !== undefined ? own['default'] : node['default']
  if (declaredDefault !== undefined) summary.default = declaredDefault
  return summary
}

export interface BodyInfo {
  summary: ManifestRequestBody
  schema: SchemaInfo | null
}

export function requestBody(reader: SpecReader, raw: RawOperation, style: ApiStyle): BodyInfo | null {
  if (reader.isSwagger2) {
    const body = raw.parameters.find((parameter) => parameter['in'] === 'body')
    if (body) {
      const schema = reader.schema(body['schema'])
      return {
        summary: {
          required: body['required'] === true,
          contentType: reader.pickMediaType(raw.operation, 'consumes'),
          schemaRef: schema?.ref ?? null,
          fields: bodyFields(reader, schema, style),
          zodSchema: null,
        },
        schema,
      }
    }
    const form = raw.parameters.filter((parameter) => parameter['in'] === 'formData')
    if (form.length === 0) return null
    return {
      summary: {
        required: form.some((parameter) => parameter['required'] === true),
        contentType: form.some((parameter) => parameter['type'] === 'file')
          ? 'multipart/form-data'
          : 'application/x-www-form-urlencoded',
        schemaRef: null,
        fields: null,
        zodSchema: null,
      },
      schema: null,
    }
  }
  const body = reader.refs.resolve(raw.operation['requestBody'])?.node
  if (!body) return null
  const picked = reader.pickContent(body['content'])
  const schema = picked ? reader.schema(picked.schema) : null
  return {
    summary: {
      required: body['required'] === true,
      contentType: picked?.contentType ?? null,
      schemaRef: schema?.ref ?? null,
      fields: bodyFields(reader, schema, style),
      zodSchema: null,
    },
    schema,
  }
}

/** The fields of an object body (what a form edits), or null for any other body. */
function bodyFields(reader: SpecReader, schema: SchemaInfo | null, style: ApiStyle): ManifestField[] | null {
  if (schema === null || fieldType(schema.node) !== 'object') return null
  return summarizeEntity(reader, schema, style).fields
}

export interface ResponseInfo {
  summary: ManifestResponse
  schema: SchemaInfo | null
}

export function successResponse(reader: SpecReader, raw: RawOperation): ResponseInfo | null {
  const responses = raw.operation['responses']
  if (!isObject(responses)) return null
  const statuses = Object.keys(responses)
    .filter((status) => /^2(\d\d|XX)$/.test(status))
    .sort((a, b) => (a === '2XX' ? 1 : b === '2XX' ? -1 : Number(a) - Number(b)))
  let fallback: ResponseInfo | null = null
  for (const status of statuses) {
    const response = reader.refs.resolve(responses[status])?.node
    if (!response) continue
    let contentType: string | null = null
    let schema: SchemaInfo | null = null
    if (reader.isSwagger2) {
      if (response['schema'] !== undefined) {
        schema = reader.schema(response['schema'])
        contentType = reader.pickMediaType(raw.operation, 'produces')
      }
    } else {
      const picked = reader.pickContent(response['content'])
      if (picked && picked.schema !== undefined) {
        schema = reader.schema(picked.schema)
        contentType = picked.contentType
      }
    }
    const info: ResponseInfo = {
      summary: { status, contentType, schemaRef: schema?.ref ?? null, isArray: schema ? isArraySchema(schema) : false },
      schema,
    }
    if (schema) return info
    fallback ??= info
  }
  return fallback
}

export function isArraySchema(info: SchemaInfo): boolean {
  return fieldType(info.node) === 'array'
}

function summarizeItems(reader: SpecReader, value: unknown): ManifestFieldItems | null {
  const info = reader.schema(value)
  if (!info) return null
  return { type: fieldType(info.node), format: textOrNull(info.node['format']), enum: enumValues(info.node), ref: info.ref }
}

function summarizeField(
  reader: SpecReader,
  name: string,
  value: unknown,
  required: boolean,
  style: ApiStyle,
): ManifestField {
  const own = isObject(value) ? value : {}
  const info = reader.schema(value) ?? { node: {}, ref: null, nullable: false }
  const type = fieldType(info.node)
  const field: ManifestField = {
    name,
    type,
    format: textOrNull(info.node['format']),
    required,
    // PostgREST lists exactly the NOT NULL columns as required (OpenAPI.hs makeTableDef), so an
    // optional column is a nullable one; elsewhere only explicit markers count.
    nullable: info.nullable || (style === 'postgrest' && !required),
    readOnly: own['readOnly'] === true || info.node['readOnly'] === true,
    enum: enumValues(info.node),
    ref: info.ref,
    items: type === 'array' ? summarizeItems(reader, info.node['items']) : null,
    description: textOrNull(own['description']) ?? textOrNull(info.node['description']),
  }
  const declaredDefault = own['default'] !== undefined ? own['default'] : info.node['default']
  if (declaredDefault !== undefined) field.default = declaredDefault
  return field
}

export function summarizeEntity(reader: SpecReader, schema: SchemaInfo, style: ApiStyle): ManifestEntity {
  const shape = reader.objectShape(schema)
  return {
    schemaRef: schema.ref,
    typeName: null,
    fields: shape.properties.map(([name, value]) => summarizeField(reader, name, value, shape.required.has(name), style)),
  }
}

// ---------------------------------------------------------------------------------------------
// List detection and pagination

const LIST_PROPERTIES = ['items', 'data', 'results', 'records', 'rows', 'content', 'list', 'entries', 'values']
const TOTAL_PROPERTIES = ['total', 'totalCount', 'total_count', 'totalItems', 'total_items', 'totalElements', 'count']
const CURSOR_PROPERTIES = ['nextCursor', 'next_cursor', 'nextPageToken', 'next_page_token', 'cursor', 'next']

export interface ListShape {
  listItemsPath: string | null
  item: SchemaInfo | null
  totalPath: string | null
  nextCursorPath: string | null
}

export function listShape(reader: SpecReader, schema: SchemaInfo | null): ListShape | null {
  if (!schema) return null
  if (isArraySchema(schema)) {
    return { listItemsPath: null, item: reader.schema(schema.node['items']), totalPath: null, nextCursorPath: null }
  }
  if (fieldType(schema.node) !== 'object') return null
  const { properties } = reader.objectShape(schema)
  const byName = new Map(properties.map(([name, value]) => [name, reader.schema(value)] as const))
  const arrays = [...byName.entries()].filter(([, info]) => info !== null && isArraySchema(info)).map(([name]) => name)
  const listItemsPath = LIST_PROPERTIES.find((name) => arrays.includes(name)) ?? (arrays.length === 1 ? arrays[0] : undefined)
  if (listItemsPath === undefined) return null
  const typed = (names: readonly string[], types: readonly FieldType[]): string | null =>
    names.find((name) => {
      const info = byName.get(name)
      return info !== undefined && info !== null && types.includes(fieldType(info.node))
    }) ?? null
  const holder = byName.get(listItemsPath)
  return {
    listItemsPath,
    item: holder ? reader.schema(holder.node['items']) : null,
    totalPath: typed(TOTAL_PROPERTIES, ['integer', 'number']),
    nextCursorPath: typed(CURSOR_PROPERTIES, ['string']),
  }
}

const PAGINATION_NAMES: ReadonlyArray<readonly [keyof Omit<ManifestPagination, 'style' | 'totalPath' | 'nextCursorPath'>, readonly string[]]> = [
  ['pageParam', ['page', 'pagenumber', 'page_number', 'pageindex', 'page_index', 'pageno']],
  ['pageSizeParam', ['pagesize', 'page_size', 'perpage', 'per_page', 'size', 'pagelimit', 'page_limit']],
  ['limitParam', ['limit', 'take', 'top', '$top', 'maxresults', 'max_results']],
  ['offsetParam', ['offset', 'skip', '$skip', 'start']],
  [
    'cursorParam',
    ['cursor', 'after', 'pagetoken', 'page_token', 'nexttoken', 'next_token', 'continuationtoken', 'continuation_token', 'startingafter', 'starting_after'],
  ],
]

export function pagination(parameters: readonly ManifestParameter[], shape: ListShape): ManifestPagination | null {
  const query = parameters.filter((parameter) => parameter.in === 'query')
  const found: Omit<ManifestPagination, 'style' | 'totalPath' | 'nextCursorPath'> = {
    pageParam: null,
    pageSizeParam: null,
    limitParam: null,
    offsetParam: null,
    cursorParam: null,
  }
  for (const [slot, names] of PAGINATION_NAMES) {
    found[slot] = query.find((parameter) => names.includes(parameter.name.toLowerCase()))?.name ?? null
  }
  const style = found.cursorParam
    ? 'cursor'
    : found.pageParam
      ? 'page'
      : found.offsetParam
        ? 'offset'
        : found.limitParam || found.pageSizeParam
          ? 'limit'
          : null
  if (style === null) return null
  return {
    style,
    ...found,
    totalPath: shape.totalPath,
    nextCursorPath: style === 'cursor' ? shape.nextCursorPath : null,
  }
}

