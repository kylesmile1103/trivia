import { useTable } from "@refinedev/react-table"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo } from "react"

import type { CustomerDto } from "@/api/generated/types.gen"
import { DataTable } from "@/components/refine-ui/data-table/data-table"
import { DataTableFilterCombobox } from "@/components/refine-ui/data-table/data-table-filter"
import { DataTableSorter } from "@/components/refine-ui/data-table/data-table-sorter"
import { Badge } from "@/components/ui/badge"

export function KitTable() {
  const columns = useMemo<ColumnDef<CustomerDto>[]>(() => [
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
          <DataTableFilterCombobox
            column={column}
            defaultOperator="in"
            multiple
            options={[
              { label: "Pending", value: "pending" },
              { label: "Active", value: "active" },
              { label: "Suspended", value: "suspended" },
            ]}
          />
        </div>
      ),
      cell: ({ getValue }) => <Badge variant="secondary">{getValue<string>()}</Badge>,
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: ({ column }) => (
        <div className="flex items-center gap-1">
          <span>Created at</span>
          <DataTableSorter column={column} />
        </div>
      ),
      cell: ({ getValue }) => new Date(getValue<string>()).toLocaleString(),
    },
  ], [])
  const table = useTable<CustomerDto>({
    columns,
    refineCoreProps: {
      resource: "customers",
      pagination: { mode: "server", pageSize: 3 },
      sorters: { mode: "server" },
      filters: { mode: "server" },
    },
  })

  return (
    <main className="grid max-w-4xl gap-5 p-6">
      <h1>Customer table</h1>
      <DataTable table={table} />
    </main>
  )
}
