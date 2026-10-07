import { useMutation, useQuery } from "@tanstack/react-query";
import { DataTable } from "@/components/data-table";
import { orderColumns } from "./order-columns";
import { listOrdersOptions } from "@/api/generated/@tanstack/react-query.gen";

export default function OrderBoard({ status }: { status: string }) {
	const { data: orderData, isLoading: isOrderLoading } = useQuery({
		...listOrdersOptions({
			query: {
				status,
				page: 1,
			},
		}),
	});

	const archive = useMutation({ mutationFn: async () => {} });

	return (
		<DataTable
			columns={orderColumns}
			onArchive={() => archive.mutate()}
			data={orderData?.data ?? []}
			isLoading={isOrderLoading}
		/>
	);
}
