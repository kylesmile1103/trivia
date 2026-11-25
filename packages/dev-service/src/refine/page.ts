// What Trivia knows about a Refine list page (docs/product.md): its `useTable` columns as the
// source has them, the Refine resource, and the contract resource it shows. Read from the
// engine's value descriptions (describeValues), never by re-parsing here.

import { refineName } from '@trivia/blueprint-compiler'
import type { ManifestField, ManifestFieldConstraints, ManifestResource, TriviaManifest } from '@trivia/contract-sync'

import { fieldShape, type FieldShape } from './columns.js'

// The engine's value descriptions (crates/trivia_oxc_engine/src/values.rs).
export type ValueDesc =
  | { kind: 'string'; value: string; line: number }
  | { kind: 'number'; value: number; line: number }
  | { kind: 'boolean'; value: boolean; line: number }
  | { kind: 'null'; line: number }
  | { kind: 'identifier'; name: string; line: number }
  | { kind: 'object'; properties: Array<{ key: string; line: number; value: ValueDesc }>; line: number }
  | { kind: 'array'; elements: ValueDesc[]; line: number }
  | { kind: 'function' | 'jsx' | 'other'; source: string; line: number }
  /** `chain`: a method chain's calls, first call first (`z.string`, then `max` with `["100"]`). */
  | { kind: 'call'; callee: string; source: string; chain: ChainCall[]; line: number }

export interface ChainCall {
  /** The method; for the first call, its whole callee (`z.string`). */
  name: string
  /** Each argument's source (an excerpt when long). */
  args: string[]
}

/** Where a file names something (engine `mentions`): `x.email`, `"email"`, `email:`, `{ email }`. */
export interface Mention {
  kind: 'member' | 'string' | 'key' | 'binding'
  line: number
  column: number
  /** The line, trimmed. */
  text: string
}

export interface ScopeValues {
  scope: string
  bindings: Array<{ name: string; path: string; line: number; via: string[]; value: ValueDesc }>
  calls: Array<{ callee: string; path: string; line: number; typeArgs: string[]; binding: string | null; args: ValueDesc[] }>
}

export interface ColumnInfo {
  /** The column's `id`, else its `accessorKey`; null when it has neither as a string. */
  key: string | null
  accessorKey: string | null
  /** The header text: a string header, or the label in its JSX (`<span>Name</span>`). */
  label: string | null
  /** Value path of the column object. */
  path: string
  line: number
  sortable: boolean
  /** The refine-ui filter its header uses (`DataTableFilterCombobox`), if any. */
  filter: string | null
  /** Its header's source, when it is a function (an excerpt: long ones end with `…`). */
  headerSource: string | null
  hasCell: boolean
  /** The contract field it shows, matched by accessorKey. */
  field: FieldInfo | null
}

export interface FieldInfo {
  name: string
  type: ManifestField['type']
  format: string | null
  shape: FieldShape
  required: boolean
  nullable: boolean
  readOnly: boolean
  enum: string[] | null
  description: string | null
  /** The bounds the contract declares (`maxLength`…), or null. */
  constraints: ManifestFieldConstraints | null
}

export interface ListPage {
  kind: 'list'
  file: string
  /** The component that calls useTable. */
  component: string
  line: number
  /** Value path of the columns array. */
  columnsPath: string
  /** The Refine resource name, and where it came from. */
  resource: { name: string; from: 'refineCoreProps' | 'typeArgument' | 'folder' } | null
  /** The row type (`useTable<CustomerDto>`). */
  rowType: string | null
  /** The contract resource the page shows, by manifest name. */
  contract: { resource: string; typeName: string | null } | null
  columns: ColumnInfo[]
  /** Contract fields of the resource the page does not show yet. */
  available: FieldInfo[]
}

/** Every list page `useTable` defines in a file's values (one per component that calls it). */
export function listPages(file: string, scopes: ScopeValues[], manifest: TriviaManifest | null): ListPage[] {
  const out: ListPage[] = []
  for (const scope of scopes) {
    const call = scope.calls.find((c) => c.callee === 'useTable')
    if (!call) continue
    const options = call.args[0]
    if (options?.kind !== 'object') continue
    const columnsProp = options.properties.find((p) => p.key === 'columns')
    let columnsPath: string
    let columns: ValueDesc | undefined
    if (columnsProp?.value.kind === 'identifier') {
      const name = columnsProp.value.name
      const binding = scope.bindings.find((b) => b.name === name) ?? scopes.find((s) => s.scope === 'module')?.bindings.find((b) => b.name === name)
      if (!binding) continue
      columnsPath = binding.path
      columns = binding.value
    } else if (columnsProp?.value.kind === 'array') {
      columnsPath = `${call.path}.columns`
      columns = columnsProp.value
    } else {
      continue
    }
    if (columns?.kind !== 'array') continue

    const rowType = call.typeArgs[0] ?? columnsRowType(scope, columnsPath)
    const resource = resourceOf(options, rowType, manifest, file)
    const contract = contractResource(manifest, resource?.name ?? null, rowType)
    const fields = (contract?.entity?.fields ?? []).map(fieldInfo)
    const infos = columns.elements.map((el, i) => columnInfo(el, i, columnsPath, fields))
    const shown = new Set(infos.flatMap((c) => [c.accessorKey, c.key]).filter((k): k is string => k !== null))
    out.push({
      kind: 'list',
      file,
      component: scope.scope,
      line: call.line,
      columnsPath,
      resource,
      rowType,
      contract: contract ? { resource: contract.name, typeName: contract.entity?.typeName ?? null } : null,
      columns: infos,
      available: fields.filter((f) => !shown.has(f.name)),
    })
  }
  return out
}

export function fieldInfo(f: ManifestField): FieldInfo {
  return {
    name: f.name,
    type: f.type,
    format: f.format,
    shape: fieldShape(f),
    required: f.required,
    nullable: f.nullable,
    readOnly: f.readOnly,
    enum: f.enum ? f.enum.filter((v): v is string => typeof v === 'string') : null,
    description: f.description,
    constraints: f.constraints ?? null,
  }
}

/** `useMemo<ColumnDef<CustomerDto>[]>` → `CustomerDto`. */
function columnsRowType(scope: ScopeValues, columnsPath: string): string | null {
  const binding = scope.bindings.find((b) => b.path === columnsPath)
  if (!binding) return null
  const memo = scope.calls.find((c) => c.callee === 'useMemo' && c.line === binding.line)
  const m = memo?.typeArgs[0]?.match(/ColumnDef<\s*([A-Za-z_$][\w$]*)/)
  return m?.[1] ?? null
}

function prop(obj: ValueDesc | undefined, key: string): ValueDesc | undefined {
  return obj?.kind === 'object' ? obj.properties.find((p) => p.key === key)?.value : undefined
}

function resourceOf(
  options: ValueDesc,
  rowType: string | null,
  manifest: TriviaManifest | null,
  file: string,
): ListPage['resource'] {
  const explicit = prop(prop(options, 'refineCoreProps'), 'resource')
  if (explicit?.kind === 'string') return { name: explicit.value, from: 'refineCoreProps' }
  const byType = rowType ? manifest?.resources.find((r) => r.entity?.typeName === rowType) : undefined
  if (byType) return { name: refineName(byType), from: 'typeArgument' }
  // Refine takes the resource from the route; pages conventionally live in a folder named after it.
  const folder = file.split('/').slice(-2, -1)[0]
  return folder && folder !== 'pages' && folder !== 'src' ? { name: folder, from: 'folder' } : null
}

export { refineName }

/** The contract resource for a Refine resource name, or for the row type. */
export function contractResource(manifest: TriviaManifest | null, name: string | null, rowType: string | null): ManifestResource | null {
  if (!manifest) return null
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (name) {
    const n = norm(name)
    const hit = manifest.resources.find(
      (r) => norm(refineName(r)) === n || norm(r.name) === n || `${norm(r.name)}s` === n || (r.tag !== null && norm(r.tag) === n),
    )
    if (hit) return hit
  }
  return (rowType ? manifest.resources.find((r) => r.entity?.typeName === rowType) : undefined) ?? null
}

function columnInfo(el: ValueDesc, index: number, columnsPath: string, fields: FieldInfo[]): ColumnInfo {
  const str = (v: ValueDesc | undefined) => (v?.kind === 'string' ? v.value : null)
  const id = str(prop(el, 'id'))
  const accessorKey = str(prop(el, 'accessorKey'))
  const header = prop(el, 'header')
  const source = header && 'source' in header ? header.source : ''
  const label =
    (header?.kind === 'string' ? header.value.trim() : source.match(/<span[^>]*>([^<{]+)<\/span>/)?.[1]?.trim()) || null
  const key = id ?? accessorKey
  const fieldName = accessorKey ?? id
  const sorting = prop(el, 'enableSorting')
  return {
    key,
    accessorKey,
    label,
    path: id !== null ? `${columnsPath}[id=${id}]` : accessorKey !== null ? `${columnsPath}[accessorKey=${accessorKey}]` : `${columnsPath}[${index}]`,
    line: el.line,
    sortable: !(sorting?.kind === 'boolean' && !sorting.value),
    filter: source.match(/<(DataTableFilter\w+)/)?.[1] ?? null,
    headerSource: source || null,
    hasCell: prop(el, 'cell') !== undefined,
    field: fields.find((f) => f.name === fieldName) ?? null,
  }
}
