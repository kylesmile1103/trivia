import { useMemo } from "react";
import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";

import type { CustomerDto } from "@/api/generated/types.gen";
import { Badge } from "@/components/ui/badge";
import { EditButton } from "@/components/refine-ui/buttons/edit";
import { DataTable } from "@/components/refine-ui/data-table/data-table";
import { DataTableSorter } from "@/components/refine-ui/data-table/data-table-sorter";
import {
  DataTableFilterCombobox,
  DataTableFilterDropdownText,
} from "@/components/refine-ui/data-table/data-table-filter";
import {
  ListView,
  ListViewHeader,
} from "@/components/refine-ui/views/list-view";

export function CustomerList() {
  const columns = useMemo<ColumnDef<CustomerDto>[]>(
    () => [
      {
        id: "fullName",
        accessorKey: "fullName",
        header: ({ column, table }) => (
          <div className="flex items-center gap-1">
            <span>Name</span>
            <DataTableSorter column={column} />
            <DataTableFilterDropdownText
              defaultOperator="contains"
              column={column}
              table={table}
              placeholder="Filter by name"
            />
          </div>
        ),
      },
      {
        id: "email",
        accessorKey: "email",
        header: "Email",
        enableSorting: false,
      },
      {
        id: "status",
        accessorKey: "status",
        header: ({ column }) => (
          <div className="flex items-center gap-1">
            <span>Status</span>
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
        cell: ({ getValue }) => (
          <Badge variant="secondary">{getValue<string>()}</Badge>
        ),
      },
      {
        id: "createdAt",
        accessorKey: "createdAt",
        header: ({ column }) => (
          <div className="flex items-center gap-1">
            <span>Customer since</span>
            <DataTableSorter column={column} />
          </div>
        ),
        cell: ({ getValue }) =>
          new Date(getValue<string>()).toLocaleDateString(),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <EditButton recordItemId={row.original.id} size="sm" variant="ghost" />
        ),
      },
    ],
    [],
  );

  const table = useTable<CustomerDto>({
    columns,
    refineCoreProps: {
      resource: "customers",
    },
  });

  return (
    <ListView>
      <ListViewHeader title="Customers" />
      <DataTable table={table} />
    </ListView>
  );
}
