import { hasErrors, pageDocPath, toPointer, type CustomPage, type Diagnostic, type ResolvedManifest } from '@trivia/blueprint'
import type { ManifestField, TriviaManifest } from '@trivia/contract-sync'

import { CompileError } from '../compile.js'
import type { JsxIR, StateIR } from '../ir.js'
import { quote, statement } from '../print/style.js'
import { refineName } from '../targets/paths.js'
import { indent, resourceRowType, snippet, withNodeAttributes, type CompositeScope } from './source.js'
import { lowerVirtualTable } from './virtual-table.js'

type Element = Extract<JsxIR, { kind: 'element' }>

export interface TableSelection {
  mode: 'single' | 'multiple'
  rows: string
  setter: string
  key: string
  rowType: string
}

export function prepareTableSelection(
  page: CustomPage, id: string, deps: ReadonlySet<string>, scope: CompositeScope, state: StateIR[],
  rename: Record<string, string>, afterState: string[],
): TableSelection | undefined {
  const { resource, selectable } = checkDataTable(page, id, scope.context.contract)
  if (!resource?.primaryKey || (selectable !== 'single' && selectable !== 'multiple')) return
  const node = page.nodes[id]!
  const rows = scope.name(node.name + 'SelectedRows')
  const setter = scope.name('set' + rows.charAt(0).toUpperCase() + rows.slice(1))
  const rowType = resourceRowType(resource, scope)
  const root = 'ui.' + node.name
  rename[root + '.selectedRows'] = rows
  state.push({ name: rows, setter, type: rowType + '[]', initial: '[]' })
  const path = root + '.selectedRow'
  if ([...deps].some((dep) => dep === root || dep === path || dep.startsWith(path + '.') || dep === root + '.*' || dep === 'ui.*')) {
    const row = scope.name(node.name + 'SelectedRow')
    rename[path] = row
    afterState.push(statement(`const ${row}: Partial<${rowType}> = ${rows}[0] ?? {}`, scope.context.facts.style))
  }
  return { mode: selectable, rows, setter, key: resource.primaryKey, rowType }
}

export function checkDataTable(page: CustomPage, id: string, contract: TriviaManifest | null | undefined) {
  const props = page.props[id] ?? {}
  const diagnostics: Diagnostic[] = []
  const report = (code: string, prop: string, message: string, index?: number) => diagnostics.push({
    code, doc: pageDocPath(page.name), pointer: toPointer(['props', id, prop, ...(index === undefined ? [] : [index])]),
    severity: 'error', message,
  })
  const resource = contract?.resources.find(({ name }) => name === props['resource'])
  if (!resource) {
    report('unknown_resource', 'resource', typeof props['resource'] === 'string'
      ? 'Unknown DataTable resource "' + props['resource'] + '".'
      : 'DataTable requires a contract resource.')
  } else if (!resource.operations.list || !resource.entity) {
    report('unsupported_operation', 'resource', resource.name + ' has no list operation with row fields.')
  }
  const fields = new Map(resource?.entity?.fields.map((field) => [field.name, field]))
  const columns: ManifestField[] = []
  if (!Array.isArray(props['columns']) || !props['columns'].length) {
    report('invalid_prop_value', 'columns', 'DataTable.columns requires at least one field name.')
  } else {
    for (const [index, name] of props['columns'].entries()) {
      const field = typeof name === 'string' ? fields.get(name) : undefined
      if (field) {
        if (!columns.includes(field)) columns.push(field)
      } else if (resource) report('unknown_field', 'columns', 'Unknown column "' + String(name) + '".', index)
    }
  }
  const filters = new Set(columns.map(({ name }) => name))
  if (props['filters'] !== undefined) {
    filters.clear()
    if (!Array.isArray(props['filters'])) report('invalid_prop_value', 'filters', 'DataTable.filters expects field names.')
    else for (const [index, name] of props['filters'].entries()) {
      if (typeof name === 'string' && columns.some((field) => field.name === name)) filters.add(name)
      else if (resource) report('unknown_field', 'filters', 'Filter "' + String(name) + '" is missing from the visible columns.', index)
    }
  }
  const pageSize = props['pageSize'] ?? 10
  if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1) {
    report('invalid_prop_value', 'pageSize', 'DataTable.pageSize expects a positive integer.')
  }
  const mode = props['pagination'] ?? 'server'
  if (mode !== 'server' && mode !== 'off') report('invalid_prop_value', 'pagination', 'DataTable.pagination expects server or off.')
  const selectable = props['selectable']
  if (selectable !== undefined && selectable !== 'single' && selectable !== 'multiple') {
    report('invalid_prop_value', 'selectable', 'DataTable.selectable expects single or multiple.')
  } else if (selectable && resource && !resource.primaryKey) {
    report('invalid_prop_value', 'selectable', 'DataTable selection requires a contract primary key.')
  }
  const virtual = props['virtual'] === true && mode === 'off'
  if (props['virtual'] !== undefined && typeof props['virtual'] !== 'boolean') {
    report('invalid_prop_value', 'virtual', 'DataTable.virtual expects a boolean.')
  } else if (props['virtual'] === true && mode === 'server') {
    diagnostics.push({
      code: 'virtual_with_server_paging', doc: pageDocPath(page.name), pointer: toPointer(['props', id, 'virtual']),
      severity: 'warning', message: 'DataTable virtual rows require pagination: off. Server paging stays active.',
    })
  }
  return { diagnostics, resource, columns, filters, pageSize, mode, selectable, virtual }
}

export function lowerDataTable(
  page: CustomPage, id: string, manifest: ResolvedManifest, root: Element, scope: CompositeScope, selection?: TableSelection,
): Element {
  const { context } = scope
  const { diagnostics, resource, columns, filters, pageSize, mode, virtual } = checkDataTable(page, id, context.contract)
  if (hasErrors(diagnostics) || !resource) throw new CompileError('invalid_result', 'Cannot compile DataTable.', { diagnostics })
  const builders = context.refineSnippets
  if (!builders) throw new CompileError('unsupported', 'The Refine column builder is unavailable.')
  const useMemo = scope.import({ name: 'useMemo', source: 'react' })
  const useTable = scope.import({ name: 'useTable', source: '@refinedev/react-table' })
  const columnDef = scope.import({ name: 'ColumnDef', source: '@tanstack/react-table', kind: 'type' })
  const row = selection?.rowType ?? resourceRowType(resource, scope)
  const columnList = scope.name('columns')
  const table = scope.name('table')
  const definitions = columns.map((field) => {
    const definition = builders.column(field, filters.has(field.name))
    return indent(snippet(definition.value, definition.imports, scope), 2) + ','
  })
  const str = (value: string) => quote(value, context.facts.style)
  let selectionOptions = ''
  if (selection) {
    const { key, rows, setter, mode } = selection
    const multiple = mode === 'multiple'
    const node = page.nodes[id]!
    const keyAt = (target: string) => target + '[' + str(key) + ']'
    const update = multiple
      ? `(event) => ${setter}((current) => event.target.checked ? [...current, row.original] : current.filter((record) => ${keyAt('record')} !== ${keyAt('row.original')}))`
      : `() => ${setter}([row.original])`
    let selectionId = 'selection'
    while (columns.some((field) => field.name === selectionId)) selectionId += '_'
    const column = `{
  id: ${str(selectionId)},
  header: "Select",
  enableSorting: false,
  cell: ({ row }) => (
    <input
      type="${multiple ? 'checkbox' : 'radio'}"
      ${multiple ? '' : 'name=' + str(node.name + '-selection') + '\n      '}aria-label={"Select row " + row.id}
      checked={row.getIsSelected()}
      onChange={${update}}
    />
  ),
},`
    definitions.unshift(indent(column, 2))
    selectionOptions = `\n  getRowId: (row) => String(${keyAt('row')}),
  state: { rowSelection: Object.fromEntries(${rows}.map((row) => [String(${keyAt('row')}), true])) },`
  }
  const columnProperty = columnList === 'columns' ? columnList : 'columns: ' + columnList
  scope.declarations.push(
    `const ${columnList} = ${useMemo}<${columnDef}<${row}>[]>(() => [\n${definitions.join('\n')}\n], []);`,
    `const ${table} = ${useTable}<${row}>({
  ${columnProperty},${selectionOptions}
  refineCoreProps: {
    resource: ${str(refineName(resource))},
    pagination: { mode: ${str(String(mode))}, pageSize: ${pageSize} },
    sorters: { mode: ${str('server')} },
    filters: { mode: ${str('server')} },
  },
});`,
  )
  if (virtual) return withNodeAttributes(root, lowerVirtualTable(table, resource.name + ' rows', scope))
  return withNodeAttributes(root, {
    kind: 'element', tag: 'section',
    props: [{ name: 'aria-label', value: { kind: 'static', value: resource.name + ' table' } }],
    children: [{
      kind: 'element', tag: scope.component(manifest), props: [{ name: 'table', value: { kind: 'expr', code: table } }], children: [],
    }],
  })
}
