import { useMutation } from "@tanstack/react-query";
import { DataTable } from "@/components/data-table";
import { orderColumns } from "./order-columns";

export default function OrderBoard({ status }: { status: string }) {
	const archive = useMutation({ mutationFn: async () => {} });

	return (
		<DataTable
			columns={orderColumns}
			onArchive={() => archive.mutate()}
		/>
	);
}
