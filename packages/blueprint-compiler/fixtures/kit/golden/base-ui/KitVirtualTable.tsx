import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";

import type { CustomerDto } from "@/api/generated/types.gen";
import { DataTableSorter } from "@/components/refine-ui/data-table/data-table-sorter";
import { Badge } from "@base/components/ui/badge";

export function KitVirtualTable() {
  const [customersSelectedRows, setCustomersSelectedRows] = useState<CustomerDto[]>([]);
  const customersSelectedRow: Partial<CustomerDto> = customersSelectedRows[0] ?? {};
  const columns = useMemo<ColumnDef<CustomerDto>[]>(() => [
    {
      id: "selection",
      header: "Select",
      enableSorting: false,
      cell: ({ row }) => (
        <input
          type="checkbox"
          aria-label={"Select row " + row.id}
          checked={row.getIsSelected()}
          onChange={(event) => setCustomersSelectedRows((current) => event.target.checked ? [...current, row.original] : current.filter((record) => record["id"] !== row.original["id"]))}
        />
      ),
    },
    {
      id: "fullName",
      accessorKey: "fullName",
      header: ({ column }) => (
        <div className="flex items-center gap-1">
          <span>Full name</span>
          <DataTableSorter column={column} />
        </div>
      ),
    },
    {
      id: "email",
      accessorKey: "email",
      header: ({ column }) => (
        <div className="flex items-center gap-1">
          <span>Email</span>
          <DataTableSorter column={column} />
        </div>
      ),
    },
    {
      id: "status",
      accessorKey: "status",
      header: ({ column }) => (
        <div className="flex items-center gap-1">
          <span>Status</span>
          <DataTableSorter column={column} />
        </div>
      ),
      cell: ({ getValue }) => <Badge variant="secondary">{getValue<string>()}</Badge>,
    },
  ], []);
  const table = useTable<CustomerDto>({
    columns,
    getRowId: (row) => String(row["id"]),
    state: { rowSelection: Object.fromEntries(customersSelectedRows.map((row) => [String(row["id"]), true])) },
    refineCoreProps: {
      resource: "customers",
      pagination: { mode: "off", pageSize: 10 },
      sorters: { mode: "server" },
      filters: { mode: "server" },
    },
  });
  const tableViewport = useRef<HTMLDivElement>(null);
  const tableRows = table.reactTable.getRowModel().rows;
  const columnCount = table.reactTable.getVisibleLeafColumns().length;
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => tableViewport.current,
    estimateSize: () => 40,
    overscan: 4,
  });
  const visibleRows = virtualizer.getVirtualItems();
  const paddingTop = visibleRows[0]?.start ?? 0;
  const paddingBottom = virtualizer.getTotalSize() - (visibleRows.at(-1)?.end ?? 0);

  return (
    <main className="grid max-w-4xl gap-5 p-6">
      <h1>Virtual customer table</h1>
      <div
        ref={tableViewport}
        role="region"
        aria-label="Customer rows"
        tabIndex={0}
        style={{ height: 480, overflow: "auto" }}
      >
        <table className="w-full table-fixed border-collapse" aria-rowcount={tableRows.length + 1}>
          <thead className="sticky top-0 z-10 bg-background">
            {table.reactTable.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sort = header.column.getSortIndex() === 0 && header.column.getIsSorted();
                  return (
                    <th key={header.id} scope="col" colSpan={header.colSpan} className="h-10 px-2 text-left"
                      aria-sort={sort === "asc" ? "ascending" : sort === "desc" ? "descending" : undefined}>
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {tableRows.length === 0 && <tr><td colSpan={columnCount} role="status">
              {table.refineCore.tableQuery.isLoading ? "Loading rows…" : "No data to display"}
            </td></tr>}
            {paddingTop > 0 && <tr aria-hidden="true"><td colSpan={columnCount} style={{ height: paddingTop, padding: 0 }} /></tr>}
            {visibleRows.map((item) => {
              const row = tableRows[item.index]!;
              return (
                <tr key={row.id} data-index={item.index} aria-rowindex={item.index + 2}
                  data-state={row.getIsSelected() ? "selected" : undefined} className="border-b" style={{ height: item.size }}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="truncate whitespace-nowrap px-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {paddingBottom > 0 && <tr aria-hidden="true"><td colSpan={columnCount} style={{ height: paddingBottom, padding: 0 }} /></tr>}
          </tbody>
        </table>
      </div>
      <p>
        {`Selected rows: ${customersSelectedRows.length}${customersSelectedRow.id ? ", first " + customersSelectedRow.id : ""}`}
      </p>
    </main>
  );
}
