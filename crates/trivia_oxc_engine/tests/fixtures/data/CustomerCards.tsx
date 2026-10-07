import { columns } from "./columns"
import { DataTable } from "@/components/data-table"

// Compact variant used on the dashboard.
export const CustomerCards = () => (
  <section className="grid gap-4">
    <DataTable columns={columns} />
  </section>
)
