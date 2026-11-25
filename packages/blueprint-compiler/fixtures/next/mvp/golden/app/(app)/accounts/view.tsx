"use client";

import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";

import type { AccountResponse } from "@/api/generated/types.gen";
import { ShowButton } from "@/components/refine-ui/buttons/show";
import { DataTable } from "@/components/refine-ui/data-table/data-table";
import { DataTableFilterDropdownText } from "@/components/refine-ui/data-table/data-table-filter";
import { DataTableSorter } from "@/components/refine-ui/data-table/data-table-sorter";
import { ListView, ListViewHeader } from "@/components/refine-ui/views/list-view";
import { Badge } from "@/components/ui/badge";

export function AccountList() {
  const columns = useMemo<ColumnDef<AccountResponse>[]>(
    () => [
      {
        id: "accountNumber",
        accessorKey: "accountNumber",
        header: ({ column }) => (
          <div className="flex items-center gap-1">
            <span>Account number</span>
            <DataTableSorter column={column} />
          </div>
        ),
      },
      {
        id: "type",
        accessorKey: "type",
        header: ({ column }) => (
          <div className="flex items-center gap-1">
            <span>Type</span>
            <DataTableSorter column={column} />
          </div>
        ),
        cell: ({ getValue }) => <Badge variant="secondary">{getValue<string>()}</Badge>,
      },
      {
        id: "balance",
        accessorKey: "balance",
        header: ({ column }) => (
          <div className="flex items-center gap-1">
            <span>Balance</span>
            <DataTableSorter column={column} />
          </div>
        ),
        cell: ({ getValue }) => getValue<number>().toLocaleString(),
      },
      {
        id: "openedOn",
        accessorKey: "openedOn",
        header: ({ column }) => (
          <div className="flex items-center gap-1">
            <span>Opened on</span>
            <DataTableSorter column={column} />
          </div>
        ),
        cell: ({ getValue }) => new Date(getValue<string>()).toLocaleDateString(),
      },
      {
        id: "customerId",
        accessorKey: "customerId",
        header: ({ column, table }) => (
          <div className="flex items-center gap-1">
            <span>Customer ID</span>
            <DataTableSorter column={column} />
            <DataTableFilterDropdownText
              defaultOperator="contains"
              column={column}
              table={table}
              placeholder="Filter by customer id"
            />
          </div>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <ShowButton recordItemId={row.original.id} size="sm" variant="ghost" />
          </div>
        ),
      },
    ],
    [],
  );

  const table = useTable<AccountResponse>({
    columns,
    refineCoreProps: {
      resource: "accounts",
    },
  });

  return (
    <ListView>
      <ListViewHeader title="Accounts" />
      <DataTable table={table} />
    </ListView>
  );
}
