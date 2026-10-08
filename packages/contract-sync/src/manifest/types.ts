// TypeScript mirror of manifest.schema.json ($id https://trivia.dev/schemas/manifest.v1.json).
// The designer reads this file to build the data explorer; the Rust data binder reads it to
// write `useQuery`/`useMutation` code. Keep the two definitions in sync (a test validates every
// generated manifest against the JSON Schema).

export const MANIFEST_SCHEMA_ID = 'https://trivia.dev/schemas/manifest.v1.json'

export type HttpMethodUpper = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'PATCH' | 'TRACE'

export type ApiStyle = 'rest' | 'postgrest'

export type SpecFormat = 'swagger-2.0' | 'openapi-3.0' | 'openapi-3.1'

/** JSON Schema primitive type of a field; `unknown` when the schema doesn't pin one down. */
export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'unknown'

export type EnumValue = string | number | boolean | null

export interface TriviaManifest {
  $schema: typeof MANIFEST_SCHEMA_ID
  manifestVersion: 1
  generator: ManifestGenerator
  source: ManifestSource
  /** `sha256:<hex>` of the canonical JSON of the input spec (key order and format independent). */
  schemaHash: string
  modules: ManifestModules
  /** Sorted by `name`. */
  resources: ManifestResource[]
}

export interface ManifestGenerator {
  name: '@trivia/contract-sync'
  version: string
  /** Exact @hey-api/openapi-ts version that produced the generated code. */
  heyApi: string
  /** hey-api plugins, in the order they were configured. */
  plugins: string[]
}

export interface ManifestSource {
  /** Project-relative POSIX path, or the URL without query string/fragment. */
  location: string
  format: SpecFormat
  /** The literal `swagger`/`openapi` version field. */
  specVersion: string
  title: string | null
  apiVersion: string | null
  style: ApiStyle
  /** `"METHOD /path"` keys left out of codegen and the manifest (e.g. PostgREST's `GET /`). */
  excludedOperations: string[]
}

export interface ManifestModule {
  /** Project-relative POSIX path of the generated file. */
  file: string
  /**
   * Import specifier for user code, e.g. "@/api/generated/@tanstack/react-query.gen", or null
   * when the output directory isn't under the import alias directory (then import relatively).
   */
  importPath: string | null
}

export interface ManifestModules {
  /** Project-relative POSIX path of the generated directory. */
  outputDir: string
  /** `@tanstack/react-query.gen.ts`: `*Options`, `*QueryKey`, `*InfiniteOptions`, `*Mutation`. */
  queries: ManifestModule
  /** `sdk.gen.ts`: one typed fetch function per operation. */
  sdk: ManifestModule
  /** `types.gen.ts`: schema and per-operation types. */
  types: ManifestModule
  /** `client.gen.ts`: the configured client instance (`client.setConfig({ baseUrl, headers })`). */
  client: ManifestModule
  /** `index.ts`: re-exports of the SDK and types. */
  index: ManifestModule
  /** `zod.gen.ts`: zod schemas for every schema and request body; null unless generated with `zod`. */
  zod: ManifestModule | null
}

export interface ManifestFieldItems {
  type: FieldType
  format: string | null
  enum: EnumValue[] | null
  /** Local `$ref` of the item schema, when it is a named definition. */
  ref: string | null
}

export interface ManifestField {
  name: string
  type: FieldType
  format: string | null
  required: boolean
  nullable: boolean
  readOnly: boolean
  enum: EnumValue[] | null
  /** Local `$ref` of the field's schema (e.g. "#/components/schemas/Address"), when named. */
  ref: string | null
  /** Element summary when `type` is "array". */
  items: ManifestFieldItems | null
  description: string | null
  /** The spec's declared default; omitted when the spec declares none. */
  default?: unknown
}

export interface ManifestEntity {
  /** Local `$ref` of the entity schema, or null when it is declared inline. */
  schemaRef: string | null
  /** The type `types.gen.ts` exports for the entity, read back from the generated code. */
  typeName: string | null
  /** Top-level properties in spec order (allOf members merged). */
  fields: ManifestField[]
}

export interface ManifestParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required: boolean
  type: FieldType
  format: string | null
  enum: EnumValue[] | null
  /** The spec's declared default (binders use it for initial values, e.g. pageSize 20). */
  default?: unknown
}

export interface ManifestRequestBody {
  required: boolean
  contentType: string | null
  schemaRef: string | null
  /** Top-level properties of an object body, in spec order; null when the body isn't an object. */
  fields: ManifestField[] | null
  /** The zod.gen.ts export that validates the body (e.g. "zCreateCustomerBody"); null without `zod`. */
  zodSchema: string | null
}

export interface ManifestResponse {
  /** The success status used, e.g. "200", "201", "204", "2XX". */
  status: string
  /** Null when the response declares no body. */
  contentType: string | null
  schemaRef: string | null
  /** True when the declared body is an array (always the case for PostgREST reads). */
  isArray: boolean
}

export type PaginationStyle = 'page' | 'offset' | 'cursor' | 'limit'

export interface ManifestPagination {
  style: PaginationStyle
  pageParam: string | null
  pageSizeParam: string | null
  limitParam: string | null
  offsetParam: string | null
  cursorParam: string | null
  /** Property of the list response holding the total count, e.g. "total". */
  totalPath: string | null
  /** Property of the list response holding the next cursor, e.g. "nextCursor". */
  nextCursorPath: string | null
}

/**
 * PostgREST has no item paths: rows are selected with a filter on the collection path
 * (`?id=eq.1`). These are the facts a binder needs to use it honestly.
 */
export interface ManifestPostgrest {
  /** Filter that selects one row, e.g. `{ param: "id", template: "eq.{value}" }`; null for list/create. */
  rowFilter: { param: string; template: 'eq.{value}' } | null
  /**
   * Media type that makes PostgREST answer with one object instead of an array (get only).
   * The generated response type is still the array (`response.isArray`), so a binder that sends
   * this header must not trust the static type; the type-safe alternative is
   * `query: { [param]: "eq.<v>", limit: "1" }` and `data?.[0]`.
   */
  singleObjectAccept: 'application/vnd.pgrst.object+json' | null
  /** `Prefer` value that makes a write return the affected rows, when the operation declares it. */
  returnRepresentation: 'return=representation' | null
  /** True for update/delete: without the row filter PostgREST would touch every visible row. */
  filterRequired: boolean
}

export type CrudKind = 'list' | 'get' | 'create' | 'update' | 'delete'
export type OperationKind = CrudKind | 'custom'

interface ManifestOperationBase {
  kind: OperationKind
  method: HttpMethodUpper
  path: string
  /** The spec's operationId, or null when the spec has none (hey-api then derives one). */
  operationId: string | null
  summary: string | null
  style: ApiStyle
  /** SDK function exported by sdk.gen.ts (verified against the generated code). */
  sdkFn: string
  /** `queryOptions` factory exported by @tanstack/react-query.gen.ts (GET operations). */
  queryOptionsFn: string | null
  queryKeyFn: string | null
  /** Present only when hey-api detected pagination for the operation. */
  infiniteQueryOptionsFn: string | null
  infiniteQueryKeyFn: string | null
  /** `UseMutationOptions` factory exported by @tanstack/react-query.gen.ts (non-GET operations). */
  mutationFn: string | null
  parameters: ManifestParameter[]
  requestBody: ManifestRequestBody | null
  response: ManifestResponse | null
}

export interface ManifestListOperation extends ManifestOperationBase {
  kind: 'list'
  /** Property holding the rows ("items", "data", …), or null when the response is a bare array. */
  listItemsPath: string | null
  pagination: ManifestPagination | null
  postgrest: ManifestPostgrest | null
}

export interface ManifestItemOperation extends ManifestOperationBase {
  kind: 'get' | 'update' | 'delete'
  /** Path parameter (REST) or filter column (PostgREST) identifying the row — not always "id". */
  idParam: string
  postgrest: ManifestPostgrest | null
}

export interface ManifestCreateOperation extends ManifestOperationBase {
  kind: 'create'
  postgrest: ManifestPostgrest | null
}

export interface ManifestCustomOperation extends ManifestOperationBase {
  kind: 'custom'
}

export type ManifestOperation =
  | ManifestListOperation
  | ManifestItemOperation
  | ManifestCreateOperation
  | ManifestCustomOperation

export type ResourceGrouping = 'x-trivia-resource' | 'tag' | 'path'

export interface ManifestResource {
  /** PascalCase singular name, e.g. "Customer"; binders derive variable names from it. */
  name: string
  /** Strongest grouping source among the resource's operations. */
  groupedBy: ResourceGrouping
  /** First tag of the resource's first operation, when tagged. */
  tag: string | null
  style: ApiStyle
  /** Collection path the CRUD operations hang off, or null when none was classified. */
  basePath: string | null
  /** `basePath/{param}` for REST item operations; always null for PostgREST. */
  itemPath: string | null
  /** Entity field identifying a row, when it can be determined. */
  primaryKey: string | null
  entity: ManifestEntity | null
  operations: {
    list: ManifestListOperation | null
    get: ManifestItemOperation | null
    create: ManifestCreateOperation | null
    update: ManifestItemOperation | null
    delete: ManifestItemOperation | null
  }
  /** Everything that isn't CRUD (e.g. POST /customers/{id}/approve-kyc), sorted by path then method. */
  customOperations: ManifestCustomOperation[]
}
