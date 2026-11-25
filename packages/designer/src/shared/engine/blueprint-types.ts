// Browser-side mirrors of the DevHost HTTP contract (LLD-04) and blueprint documents.
import type { JsonValue, Op, TriviaManifest } from './types'

export const APP_DOC = 'app.blueprint.json'
export const MODEL_DOC = 'model.blueprint.json'
export const pageDocPath = (name: string) => `pages/${name}.page.json`

export interface BlueprintDiagnostic {
  code: string
  severity: 'error' | 'warning'
  doc: string
  pointer: string
  message: string
  hint?: { ops?: BlueprintOp[]; text?: string }
  span?: { start: number; end: number; unit: 'utf16' }
}

export interface BlueprintApp {
  $schema: string
  blueprintVersion: 1
  name: string
  targets: { web: 'vite-refine' | 'next-refine'; api?: 'dotnet-minimal' }
  auth: { mode: 'none' | 'oidc' }
  theme: { tokens: Record<string, string> }
  nav: Array<{ page: string; label: string; icon?: string }>
}

export const CONTRACT_KINDS = ['list', 'create', 'edit', 'show'] as const
export type ContractKind = typeof CONTRACT_KINDS[number]
export type BlueprintPageKind = ContractKind | 'custom'

export type ActionStep =
  | { do: 'setState'; name: string; value: string }
  | { do: 'navigate'; to: string }
  | { do: 'mutate'; resource: string; operation: string; input?: string; id?: string }
  | { do: 'refetch'; query: string }
  | { do: 'toast'; message: string; variant?: 'default' | 'success' | 'info' | 'warning' | 'error' }
  | { do: 'call'; handler: string }

export type ContractAction = {
  name: string
  label: string
  confirm?: string
  steps: ActionStep[]
}

export interface ContractOptions {
  fields?: string[]
  hideFields?: string[]
  title?: string
  filters?: string[]
  rowActions?: ContractAction[]
  headerActions?: ContractAction[]
}

interface PageEnvelope {
  $schema: string
  blueprintVersion: 1
  id: string
  name: string
  route: string
  public: boolean
}

export interface BlueprintNode {
  type: string
  name: string
  parent: string | null
  slot: string | null
  order: string
}

type BlueprintControl = { when: string } | { when?: string; each: string; as: string; key: string }
type BlueprintQuery = ({ kind: 'list' | 'one' } | { kind: 'custom'; operation: string }) & {
  resource: string; params?: Record<string, string>; enabled?: string
}
type NodeMap<T> = Record<string, T>

export interface CustomPage extends PageEnvelope {
  kind: 'custom'
  resource?: string
  root: string
  nodes: NodeMap<BlueprintNode>
  props: NodeMap<Record<string, JsonValue>>
  bindings: NodeMap<Record<string, string>>
  styles: NodeMap<{ className: string }>
  control: NodeMap<BlueprintControl>
  state: Record<string, { type: string; initial: JsonValue }>
  queries: Record<string, BlueprintQuery>
  actions: Record<string, ActionStep[]>
}

export interface ContractPage extends PageEnvelope {
  kind: ContractKind
  resource: string
  options: ContractOptions
}

export type BlueprintPage = ContractPage | CustomPage

export type ModelKey = { name: string } & ({ type: 'uuid'; generated?: 'v7' } | { type: 'int' | 'long' })
export const MODEL_FIELD_TYPES = ['string', 'text', 'int', 'long', 'decimal', 'bool', 'date', 'uuid', 'json', 'datetime', 'enum'] as const
export type ModelField = {
  name: string
  required?: boolean
  unique?: boolean
  readOnly?: boolean
  default?: JsonValue
  description?: string
  renamedFrom?: string
} & (
  | { type: 'string' | 'text'; minLength?: number; maxLength?: number; pattern?: string; format?: 'email' | 'uri' | 'password' }
  | { type: 'int' | 'long'; minimum?: number; maximum?: number }
  | { type: 'decimal'; precision: number; scale: number; minimum?: number; maximum?: number }
  | { type: 'bool' | 'date' | 'uuid' | 'json' }
  | { type: 'datetime'; generated?: 'onCreate' | 'onUpdate' }
  | { type: 'enum'; enum: string }
)

export type ModelRelation = { name: string; to: string; foreignKey: string } & (
  { kind: 'belongsTo'; required?: boolean; onDelete?: 'restrict' | 'cascade' | 'setNull' } | { kind: 'hasMany' }
)
type ModelIndex = { fields: string[]; unique?: boolean }
type ModelEnum = { name: string; values: string[] }

export interface ModelApi {
  operations: Array<keyof TriviaManifest['resources'][number]['operations']>
  filterable?: string[]
  sortable?: string[]
  searchable?: string[]
  custom?: Array<{ name: string; method: string; path: string; input?: ModelField[]; returns?: string }>
}

export interface ModelEntity {
  name: string
  plural: string
  key: ModelKey
  fields: ModelField[]
  relations: ModelRelation[]
  indexes: ModelIndex[]
  api: ModelApi
  concurrency?: boolean
  renamedFrom?: string
}

export interface BlueprintModel {
  $schema: string
  blueprintVersion: 1
  namespace: string
  enums: ModelEnum[]
  entities: ModelEntity[]
}

type Revision = { baseRev: string | null }
type AppOp = { doc: typeof APP_DOC } & Revision
type PageOp = { doc: string } & Revision
type NodeOp = PageOp & { node: string; expectedType: string }
type Position = { before: string } | { after: string } | { index: number } | { before?: never; after?: never; index?: never }
type ModelOp = { doc: typeof MODEL_DOC } & Revision
type EntityOp = ModelOp & { entity: string }

export type BlueprintOp =
  | (AppOp & { op: 'setApp'; name?: string; targets?: { web?: BlueprintApp['targets']['web']; api?: 'dotnet-minimal' | null }; auth?: BlueprintApp['auth']; theme?: { tokens: Record<string, string | null> } })
  | (AppOp & { op: 'setNav'; nav: BlueprintApp['nav'] })
  | (PageOp & { op: 'createPage'; name: string; route: string; kind: BlueprintPageKind; resource?: string; public?: boolean; options?: ContractOptions; rootType?: string })
  | (PageOp & { op: 'deletePage' })
  | (PageOp & { op: 'setPageMeta'; name?: string; route?: string; kind?: ContractKind; resource?: string | null; public?: boolean; options?: ContractOptions })
  | (PageOp & Position & { op: 'addNode'; parent: string; expectedType: string; type: string; name: string; slot: string })
  | (NodeOp & Position & { op: 'moveNode'; parent: string; slot: string })
  | (NodeOp & { op: 'removeNode' })
  | (NodeOp & { op: 'renameNode'; name: string })
  | (NodeOp & { op: 'setProp'; prop: string; value: JsonValue })
  | (NodeOp & { op: 'setBinding'; prop: string; expr: string | null })
  | (NodeOp & { op: 'setStyle'; className: string | null })
  | (NodeOp & { op: 'setControl'; control: BlueprintControl | null })
  | (PageOp & { op: 'setState'; name: string; type: string; initial: JsonValue })
  | (PageOp & { op: 'removeState'; name: string })
  | (PageOp & { op: 'setQuery'; name: string; query: BlueprintQuery })
  | (PageOp & { op: 'removeQuery'; name: string })
  | (NodeOp & { op: 'setActions'; event: string; steps: ActionStep[] })
  | (ModelOp & { op: 'setModel'; namespace: string })
  | (ModelOp & { op: 'setEnum'; enum: ModelEnum })
  | (ModelOp & { op: 'removeEnum'; name: string })
  | (ModelOp & { op: 'setEntity'; entity: { name: string } & Partial<Omit<ModelEntity, 'name' | 'renamedFrom'>> })
  | (EntityOp & { op: 'removeEntity' })
  | (EntityOp & { op: 'renameEntity'; name: string })
  | (EntityOp & { op: 'setField'; field: ModelField })
  | (EntityOp & { op: 'removeField'; field: string })
  | (EntityOp & { op: 'renameField'; field: string; name: string })
  | (EntityOp & { op: 'moveField'; field: string; index: number })
  | (EntityOp & { op: 'setRelation'; relation: ModelRelation })
  | (EntityOp & { op: 'removeRelation'; relation: string })
  | (EntityOp & { op: 'setIndexes'; indexes: ModelIndex[] })
  | (EntityOp & { op: 'setEntityApi'; api: ModelApi })

export interface BlueprintPageSummary {
  name: string
  path: string
  rev: string
  route: string
  kind: BlueprintPageKind
  status: 'draft' | 'ejected' | 'edited'
  file?: string
  errors: number
  warnings: number
}

export interface BlueprintSummary {
  dir: string
  exists: boolean
  app: { rev: string; name: string; targets: BlueprintApp['targets'] } | null
  model: { rev: string; entities: string[] } | null
  pages: BlueprintPageSummary[]
  diagnostics: BlueprintDiagnostic[]
  next: string
}

export interface BlueprintDocument<T = BlueprintApp | BlueprintPage | BlueprintModel> {
  path: string
  rev: string
  doc: T
  projection?: string
}

export interface BlueprintSlot {
  name: string
  kind: 'nodes' | 'text'
  accepts?: string[]
  wrapper?: string
}

export interface BlueprintComponent {
  type: string
  installed: boolean
  slots: BlueprintSlot[]
  events: Array<{ name: string; prop: string; payload?: string }>
  exposes: Array<{ name: string; type: string; initial: JsonValue; via: {
    valueProp: string; changeProp: string; changeArg: 'value' | 'event.target.value' | 'event.target.checked'
  } }>
}

export interface BlueprintPropSchema {
  type?: 'string' | 'number' | 'boolean'
  enum?: string[]
  description?: string
  default?: JsonValue
}

export interface BlueprintComponents {
  components: BlueprintComponent[]
  schemas: Record<string, { properties: Record<string, BlueprintPropSchema>; required?: string[] }>
}

export interface BlueprintPatchResult {
  changed: boolean
  revs: Record<string, string | null>
  created: Record<string, string>
  diagnostics: BlueprintDiagnostic[]
  entry: string | null
  summary: BlueprintSummary
}

export interface RegistryItem {
  registry: 'shadcn' | 'refine' | 'local'
  item: string
}

export interface BlueprintPreview {
  page: string
  route: string
  module: string
  code: string
  requires: RegistryItem[]
  diagnostics: BlueprintDiagnostic[]
}

export interface BlueprintEjectPlan {
  ops: Op[]
  files: string[]
  requires: RegistryItem[]
  warnings: string[]
  lock: { lockVersion: 1; compiler?: string; pages: Record<string, {
    file: string; hash: string; blueprintRev?: string; route?: string; component?: string
  }> }
  label: string
}

export interface BlueprintBackendRequest {
  mode: 'plan' | 'write'
  migration?: string
  force?: boolean
}

export interface BlueprintBackendResult {
  files: Array<{ path: string; kind: 'generated' | 'scaffold'; action: 'create' | 'update' | 'unchanged' | 'delete' | 'refused' }>
  written: boolean
  diagnostics: BlueprintDiagnostic[]
  log: string
}
