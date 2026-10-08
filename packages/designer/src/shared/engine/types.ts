// TypeScript mirror of the engine contract (docs/api.md). Keep in sync with the Rust serde
// types in crates/trivia_oxc_engine/src/{ops/mod,ops/bind_query,inspect,prop_analyzer,error}.rs.

export type Placement = 'before' | 'after' | 'firstChild' | 'lastChild'

export interface ImportSpec {
  name: string
  source: string
  default?: boolean
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * One serializable edit — the action vocabulary for humans and agents alike.
 *
 * Every locator an op names can carry the tag name the sender saw there (`expectedName` for
 * the op's own node: the insert target, the insertChild parent, the moved/removed/updated
 * node; `expectedTargetName` / `expectedParentName` for a move's anchor). Locators are
 * positions, so the engine answers 409 `stale_locator` when one now names something else.
 */
export type Op =
  | { op: 'insert'; target: string; expectedName?: string; placement: Placement; snippet: string; imports?: ImportSpec[] }
  | { op: 'insertChild'; parent: string; expectedName?: string; index: number; snippet: string; imports?: ImportSpec[] }
  | { op: 'updateProp'; target: string; expectedName?: string; prop: string; value: JsonValue }
  | { op: 'setText'; target: string; expectedName?: string; text: string }
  | { op: 'createFile'; file: string; content: string; ifMissing?: boolean }
  | { op: 'remove'; target: string; expectedName?: string }
  | { op: 'move'; source: string; expectedName?: string; target: string; expectedTargetName?: string; placement: Placement }
  | { op: 'moveNode'; source: string; expectedName?: string; parent: string; expectedParentName?: string; index: number }
  | ({ op: 'bindQuery' } & QueryBinding)
  // Value ops: object and array literals addressed by value path (docs/api.md).
  | { op: 'insertElement'; path: string; index?: number; value: string; imports?: ImportSpec[] }
  | { op: 'removeElement'; path: string }
  | { op: 'moveElement'; path: string; index: number }
  | { op: 'setProperty'; path: string; prop: string; value: string; imports?: ImportSpec[] }
  | { op: 'removeProperty'; path: string; prop: string }

/** Ops that address a value path rather than a JSX locator. */
export type ValueOp = Extract<Op, { path: string }>

export function isValueOp(op: Op): op is ValueOp {
  return 'path' in op
}

/** Bind an element to a TanStack Query factory (engine: ops/bind_query.rs). */
export interface QueryBinding {
  /** Locator of the element to bind, e.g. a <DataTable>. */
  target: string
  expectedName?: string
  /** Generated option factory, e.g. "listCustomersOptions" (from trivia.manifest.json). */
  optionsFn: string
  /** Module exporting it, e.g. "@/api/generated/@tanstack/react-query.gen". */
  optionsImport: string
  /** JS expression passed to the factory, e.g. "{ query: { page: 1, pageSize: 20 } }". */
  optionsArgs?: string | null
  /** Resource name; "Customer" → customerData / isCustomerLoading. */
  resource: string
  /** Path to the items inside the response ("items", "data.items"); null for a bare array. */
  itemsPath?: string | null
  dataProp: string
  loadingProp?: string | null
}

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

export interface ApplyResult {
  file: string
  changed: boolean
  /** Locator of the inserted/moved/updated node after the edit; null after a removal. */
  locator: string | null
  history: HistoryState
}

export interface HistoryResult {
  files: string[]
  history: HistoryState
}

export interface Health {
  root: string
  uiDir: string
  importBase: string
  version: string
}

export type AttrKind = 'string' | 'expression' | 'shorthand' | 'element' | 'spread'

export interface AttrDetails {
  /** null for {...spread} */
  name: string | null
  kind: AttrKind
  /** Literal value when editable (strings, {true}, {3}, shorthand → true). */
  value: JsonValue | null
  /** Source text of the value, for read-only display. */
  source: string
}

export interface NodeDetails {
  locator: string
  file: string
  /** Tag name as written (Button, div); "<>" for fragments. */
  name: string
  isFragment: boolean
  line: number
  column: number
  isRoot: boolean
  /** False when rendered from a {…} expression. */
  isDirect: boolean
  parent: string | null
  children: string[]
  attributes: AttrDetails[]
  /** The element's text when its only content is plain text. */
  text: string | null
}

export type PropKind =
  | { kind: 'enum'; options: string[] }
  | { kind: 'boolean' }
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'className' }
  | { kind: 'unknown'; typeText: string }

export type PropSchema = PropKind & {
  name: string
  optional: boolean
  default?: JsonValue
  source: 'declared' | 'variant' | 'intrinsic'
}

export interface ComponentSchema {
  name: string
  file: string
  importSource: string
  baseElement: string | null
  acceptsChildren: boolean
  props: PropSchema[]
  /** Parts of the props type the analyzer couldn't expand (source text); absent when none. */
  unresolvedTypes?: string[]
}

export type ErrorCode =
  | 'invalid_locator'
  | 'node_not_found'
  | 'stale_locator'
  | 'parse_error'
  | 'unsupported'
  | 'invalid_snippet'
  | 'unresolved_component'
  | 'invalid_result'
  | 'invalid_op'
  | 'path_outside_root'
  | 'io_error'
  | 'internal'
  | 'conflict'
  | 'forbidden'

export interface ApiErrorPayload {
  code: ErrorCode
  message: string
}

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: ApiErrorPayload }

/** GET/POST /selection (docs/mcp.md): what the designer has selected, as the plugin holds it. */
export interface SelectionState {
  selection: { locator: string; name: string } | null
  /** Bumped on every change. */
  version: number
  /** Who made the last change: an agent's edit moves the selection with its element. */
  by: 'designer' | 'agent' | null
}

// ---------------------------------------------------------------------------------------------
// GET /manifest: contract-sync's trivia.manifest.json, the part the Data panel reads. Mirror of
// packages/contract-sync/src/manifest/types.ts; keep the two in sync.

export type ManifestFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'unknown'

export interface ManifestField {
  name: string
  type: ManifestFieldType
  format: string | null
  required: boolean
  nullable: boolean
  readOnly: boolean
  enum: Array<string | number | boolean | null> | null
  description: string | null
}

export interface ManifestModule {
  file: string
  /** Import specifier for user code; null when the output isn't under the import alias. */
  importPath: string | null
}

export interface ManifestRequestBody {
  required: boolean
  contentType: string | null
  /** An object body's top-level fields (what a form edits); null otherwise. */
  fields: ManifestField[] | null
  /** The zod.gen.ts export validating it; null without `--zod`. */
  zodSchema: string | null
}

export interface ManifestOperation {
  kind: 'list' | 'get' | 'create' | 'update' | 'delete' | 'custom'
  method: string
  path: string
  summary: string | null
  sdkFn: string
  queryOptionsFn: string | null
  queryKeyFn: string | null
  mutationFn: string | null
  requestBody: ManifestRequestBody | null
  /** List operations: where the rows are ("items"), null for a bare array. */
  listItemsPath?: string | null
}

export interface ManifestResource {
  name: string
  primaryKey: string | null
  entity: { fields: ManifestField[] } | null
  operations: Record<'list' | 'get' | 'create' | 'update' | 'delete', ManifestOperation | null>
  customOperations: ManifestOperation[]
}

export interface TriviaManifest {
  source: { location: string; title: string | null }
  schemaHash: string
  modules: {
    outputDir: string
    queries: ManifestModule
    zod: ManifestModule | null
  }
  resources: ManifestResource[]
}

export interface Drift {
  status: 'current' | 'changed' | 'unknown'
  source: string | null
  manifestHash: string | null
  specHash: string | null
}

export interface ManifestState {
  manifest: TriviaManifest | null
  drift: Drift | null
}

// ---------------------------------------------------------------------------------------------
// Refine pages (vite-plugin-ast-locator src/refine, docs/product.md)

export type FieldShape = 'text' | 'enum' | 'number' | 'date' | 'dateTime' | 'boolean' | 'list' | 'other'

export interface PageField {
  name: string
  type: string
  format: string | null
  shape: FieldShape
  required: boolean
  nullable: boolean
  readOnly: boolean
  enum: string[] | null
  description: string | null
}

export interface PageColumn {
  key: string | null
  accessorKey: string | null
  label: string | null
  path: string
  line: number
  sortable: boolean
  filter: string | null
  hasCell: boolean
  field: PageField | null
}

export interface ListPage {
  kind: 'list'
  file: string
  component: string
  line: number
  columnsPath: string
  resource: { name: string; from: 'refineCoreProps' | 'typeArgument' | 'folder' } | null
  rowType: string | null
  contract: { resource: string; typeName: string | null } | null
  columns: PageColumn[]
  available: PageField[]
}

export type ColumnChange =
  | { action: 'add'; field: string; index?: number; label?: string }
  | { action: 'remove'; column: string }
  | { action: 'move'; column: string; index: number }

export interface ColumnPlan {
  ops: Op[]
  label: string
}

