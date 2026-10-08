import { useMemo } from "react";
import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";

import type { AccountDto } from "@/api/generated/types.gen";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/refine-ui/data-table/data-table";
import { DataTableSorter } from "@/components/refine-ui/data-table/data-table-sorter";
import {
  ListView,
  ListViewHeader,
} from "@/components/refine-ui/views/list-view";

export function AccountList() {
  const columns = useMemo<ColumnDef<AccountDto>[]>(
    () => [
      {
        id: "iban",
        accessorKey: "iban",
        header: "IBAN",
        enableSorting: false,
      },
      {
        id: "type",
        accessorKey: "type",
        header: "Type",
        cell: ({ getValue }) => (
          <Badge variant="outline">{getValue<string>()}</Badge>
        ),
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
        cell: ({ row, getValue }) =>
          getValue<number>().toLocaleString(undefined, {
            style: "currency",
            currency: row.original.currency,
          }),
      },
    ],
    [],
  );

  const table = useTable<AccountDto>({
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
