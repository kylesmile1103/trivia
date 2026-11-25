import type { JsxIR } from '../ir.js'
import { quote } from '../print/style.js'
import type { CompositeScope } from './source.js'

/** The registry DataTable has no body renderer slot. Reuse its TanStack column definitions. */
export function lowerVirtualTable(table: string, label: string, scope: CompositeScope): Extract<JsxIR, { kind: 'element' }> {
  const useRef = scope.import({ name: 'useRef', source: 'react' })
  const useVirtualizer = scope.import({ name: 'useVirtualizer', source: '@tanstack/react-virtual' })
  const flexRender = scope.import({ name: 'flexRender', source: '@tanstack/react-table' })
  const view = scope.name('tableViewport')
  const rows = scope.name('tableRows')
  const virtualizer = scope.name('virtualizer')
  const items = scope.name('visibleRows')
  const top = scope.name('paddingTop')
  const bottom = scope.name('paddingBottom')
  const columnCount = scope.name('columnCount')
  const cls = scope.context.facts.style
  scope.declarations.push(
    `const ${view} = ${useRef}<HTMLDivElement>(null);`,
    `const ${rows} = ${table}.reactTable.getRowModel().rows;`,
    `const ${columnCount} = ${table}.reactTable.getVisibleLeafColumns().length;`,
    `const ${virtualizer} = ${useVirtualizer}({
  count: ${rows}.length,
  getScrollElement: () => ${view}.current,
  estimateSize: () => 40,
  overscan: 4,
});`,
    `const ${items} = ${virtualizer}.getVirtualItems();`,
    `const ${top} = ${items}[0]?.start ?? 0;`,
    `const ${bottom} = ${virtualizer}.getTotalSize() - (${items}.at(-1)?.end ?? 0);`,
  )
  const spacer = (size: string) => `{${size} > 0 && <tr aria-hidden="true"><td colSpan={${columnCount}} style={{ height: ${size}, padding: 0 }} /></tr>}`
  return {
    kind: 'element', tag: 'div',
    props: [
      { name: 'ref', value: { kind: 'expr', code: view } },
      { name: 'role', value: { kind: 'static', value: 'region' } },
      { name: 'aria-label', value: { kind: 'static', value: label } },
      { name: 'tabIndex', value: { kind: 'static', value: 0 } },
      { name: 'style', value: { kind: 'expr', code: `{ height: 480, overflow: ${quote('auto', cls)} }` } },
    ],
    children: [{ kind: 'source', code: `<table className="w-full table-fixed border-collapse" aria-rowcount={${rows}.length + 1}>
  <thead className="sticky top-0 z-10 bg-background">
    {${table}.reactTable.getHeaderGroups().map((group) => (
      <tr key={group.id}>
        {group.headers.map((header) => {
          const sort = header.column.getSortIndex() === 0 && header.column.getIsSorted();
          return (
            <th key={header.id} scope="col" colSpan={header.colSpan} className="h-10 px-2 text-left"
              aria-sort={sort === "asc" ? "ascending" : sort === "desc" ? "descending" : undefined}>
              {header.isPlaceholder ? null : ${flexRender}(header.column.columnDef.header, header.getContext())}
            </th>
          );
        })}
      </tr>
    ))}
  </thead>
  <tbody>
    {${rows}.length === 0 && <tr><td colSpan={${columnCount}} role="status">
      {${table}.refineCore.tableQuery.isLoading ? "Loading rows…" : "No data to display"}
    </td></tr>}
    ${spacer(top)}
    {${items}.map((item) => {
      const row = ${rows}[item.index]!;
      return (
        <tr key={row.id} data-index={item.index} aria-rowindex={item.index + 2}
          data-state={row.getIsSelected() ? "selected" : undefined} className="border-b" style={{ height: item.size }}>
          {row.getVisibleCells().map((cell) => (
            <td key={cell.id} className="truncate whitespace-nowrap px-2">
              {${flexRender}(cell.column.columnDef.cell, cell.getContext())}
            </td>
          ))}
        </tr>
      );
    })}
    ${spacer(bottom)}
  </tbody>
</table>` }],
  }
}
