import { getCustomerById } from "@/api/generated/sdk.gen";
import { apiData, apiRequest } from "@/server/api";
import { CustomerShow as View } from "./view";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id: recordId } = await params;
  const request = await apiRequest();
  const initialRecord = { data: apiData(await getCustomerById({ ...request, path: { id: recordId } })) };
  return <View recordId={recordId} initialRecord={initialRecord} />;
}
