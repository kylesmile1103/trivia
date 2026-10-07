// Customers page: every customer in one table, newest first.
import { DataTable } from "@/components/data-table"
import { Button } from "@/components/ui/button"

import { columns } from "./columns"

/**
 * The list view the designer binds to `Customer.operations.list`.
 */
export function CustomerList() {
  // The heading stays static.
  const title = "Customers"

  return (
    <div className="container mx-auto py-10">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {/* rows come from the API once bound */}
      <DataTable columns={columns} data={[]} />

      <Button variant="outline">Export</Button>
    </div>
  )
}
