import { pageDocPath, toPointer, type CustomPage, type Diagnostic, type ResolvedManifest } from '@trivia/blueprint'
import type { ManifestField, ManifestResource, TriviaManifest } from '@trivia/contract-sync'

import { CompileError } from '../compile.js'
import type { JsxIR } from '../ir.js'
import { quote } from '../print/style.js'
import { refineName } from '../targets/vite-refine/files.js'
import { indent, snippet, withNodeAttributes, type CompositeScope } from './source.js'

type Element = Extract<JsxIR, { kind: 'element' }>

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
  return { diagnostics, resource, columns, filters, pageSize, mode }
}

export function lowerDataTable(
  page: CustomPage, id: string, manifest: ResolvedManifest, root: Element, scope: CompositeScope,
): Element {
  const { context } = scope
  const { diagnostics, resource, columns, filters, pageSize, mode } = checkDataTable(page, id, context.contract)
  if (diagnostics.length || !resource) throw new CompileError('invalid_result', 'Cannot compile DataTable.', { diagnostics })
  const builders = context.refineSnippets
  if (!builders) throw new CompileError('unsupported', 'The Refine column builder is unavailable.')
  const useMemo = scope.import({ name: 'useMemo', source: 'react' })
  const useTable = scope.import({ name: 'useTable', source: '@refinedev/react-table' })
  const columnDef = scope.import({ name: 'ColumnDef', source: '@tanstack/react-table', kind: 'type' })
  const row = tableRowType(resource, scope)
  const columnList = scope.name('columns')
  const table = scope.name('table')
  const tag = scope.component(manifest)
  const definitions = columns.map((field) => {
    const definition = builders.column(field, filters.has(field.name))
    return indent(snippet(definition.value, definition.imports, scope), 2) + ','
  })
  const str = (value: string) => quote(value, context.facts.style)
  const columnProperty = columnList === 'columns' ? columnList : 'columns: ' + columnList
  scope.declarations.push(
    `const ${columnList} = ${useMemo}<${columnDef}<${row}>[]>(() => [\n${definitions.join('\n')}\n], []);`,
    `const ${table} = ${useTable}<${row}>({
  ${columnProperty},
  refineCoreProps: {
    resource: ${str(refineName(resource))},
    pagination: { mode: ${str(String(mode))}, pageSize: ${pageSize} },
    sorters: { mode: ${str('server')} },
    filters: { mode: ${str('server')} },
  },
});`,
  )
  return withNodeAttributes(root, {
    kind: 'element', tag, props: [{ name: 'table', value: { kind: 'expr', code: table } }], children: [],
  })
}

export function tableRowType(resource: ManifestResource, scope: CompositeScope): string {
  const name = resource.entity?.typeName
  const source = scope.context.contract?.modules.types?.importPath
  return name && source ? scope.import({ name, source, kind: 'type' })
    : scope.import({ name: 'BaseRecord', source: '@refinedev/core', kind: 'type' })
}
