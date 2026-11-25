"use client";

import { useCustomMutation } from "@refinedev/core";
import { useTable } from "@refinedev/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import type { MouseEvent } from "react";
import { useCallback, useMemo } from "react";

import type { CustomerResponse } from "@/api/generated/types.gen";
import { EditButton } from "@/components/refine-ui/buttons/edit";
import { ShowButton } from "@/components/refine-ui/buttons/show";
import { DataTable } from "@/components/refine-ui/data-table/data-table";
import { DataTableFilterCombobox, DataTableFilterDropdownText } from "@/components/refine-ui/data-table/data-table-filter";
import { DataTableSorter } from "@/components/refine-ui/data-table/data-table-sorter";
import { ListView, ListViewHeader } from "@/components/refine-ui/views/list-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function CustomerList() {
  const mutateCustom = useCustomMutation();

  const handleApproveKyc = useCallback(async (_event: MouseEvent<HTMLButtonElement>, _row: CustomerResponse) => {
    if (!window.confirm("Approve KYC for this customer?")) return;
    await mutateCustom.mutateAsync({ url: "/api/v1/customers/" + encodeURIComponent(String(_row.id)) + "/approve-kyc", method: "post", values: {} });
  }, [mutateCustom.mutateAsync]);

  async function handleRefresh(_event: MouseEvent<HTMLButtonElement>) {
    await table.refineCore.tableQuery.refetch();
  }

  const columns = useMemo<ColumnDef<CustomerResponse>[]>(
    () => [
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
        header: ({ column, table }) => (
          <div className="flex items-center gap-1">
            <span>Email</span>
            <DataTableSorter column={column} />
            <DataTableFilterDropdownText
              defaultOperator="contains"
              column={column}
              table={table}
              placeholder="Filter by email"
            />
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
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button type="button" onClick={(event) => void handleApproveKyc(event, row.original).catch(console.error)}>Approve KYC</Button>
            <EditButton recordItemId={row.original.id} size="sm" variant="ghost" />
            <ShowButton recordItemId={row.original.id} size="sm" variant="ghost" />
          </div>
        ),
      },
    ],
    [handleApproveKyc],
  );

  const table = useTable<CustomerResponse>({
    columns,
    refineCoreProps: {
      resource: "customers",
    },
  });

  return (
    <ListView>
      <ListViewHeader title="Customers" />
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={(event) => void handleRefresh(event).catch(console.error)}>Refresh</Button>
      </div>
      <DataTable table={table} />
    </ListView>
  );
}
