"use client";

import { useMemo } from "react";
import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";

import type { TransactionDto } from "@/api/generated/types.gen";
import { DataTable } from "@/components/refine-ui/data-table/data-table";
import { DataTableSorter } from "@/components/refine-ui/data-table/data-table-sorter";
import {
  ListView,
  ListViewHeader,
} from "@/components/refine-ui/views/list-view";

// No resource in refineCoreProps: Refine takes it from the route (/transactions).
export function TransactionList() {
  const columns = useMemo<ColumnDef<TransactionDto>[]>(
    () => [
      {
        id: "bookedAt",
        accessorKey: "bookedAt",
        header: ({ column }) => (
          <div className="flex items-center gap-1">
            <span>Booked</span>
            <DataTableSorter column={column} />
          </div>
        ),
        cell: ({ getValue }) => new Date(getValue<string>()).toLocaleString(),
      },
      {
        id: "counterparty",
        accessorKey: "counterparty",
        header: "Counterparty",
      },
      {
        id: "amount",
        accessorKey: "amount",
        header: "Amount",
        cell: ({ row, getValue }) =>
          `${row.original.direction === "debit" ? "−" : "+"}${getValue<number>().toLocaleString(undefined, {
            style: "currency",
            currency: row.original.currency,
          })}`,
      },
    ],
    [],
  );

  const table = useTable<TransactionDto>({
    columns,
  });

  return (
    <ListView>
      <ListViewHeader title="Transactions" />
      <DataTable table={table} />
    </ListView>
  );
}
