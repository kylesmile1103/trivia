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
