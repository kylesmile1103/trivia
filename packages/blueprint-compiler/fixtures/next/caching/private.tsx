import { getCustomerById as __bpSdk1 } from "@/api/generated/sdk.gen"
import { apiData, apiRequest } from "@/server/api"

async function __bpLoad_customer(options: NonNullable<Parameters<typeof __bpSdk1>[0]>) {
  const value = apiData(await __bpSdk1(options))
  return { data: value }
}

export default async function KitTable({ params }: { params: Promise<{ id: string }> }) {
  const __bpParams = await params
  const __bpApi = await apiRequest()
  const __bpQuery_customer = await __bpLoad_customer({ ...__bpApi, path: { id: __bpParams.id } })

  return (
    <main className="grid max-w-4xl gap-5 p-6">
      <h1>{__bpQuery_customer?.data?.fullName}</h1>
    </main>
  )
}
