import { columns } from "./columns"
import { DataTable } from "@/components/data-table"
import { useQuery } from "@tanstack/react-query"
import { listCustomersOptions } from "@/api/generated/@tanstack/react-query.gen"

// Compact variant used on the dashboard.
export const CustomerCards = () => {
  const { data: customerData, isLoading: isCustomerLoading } = useQuery({ ...listCustomersOptions() })

  return (
  <section className="grid gap-4">
    <DataTable columns={columns} data={customerData?.items ?? []} isLoading={isCustomerLoading} />
  </section>
)
}
