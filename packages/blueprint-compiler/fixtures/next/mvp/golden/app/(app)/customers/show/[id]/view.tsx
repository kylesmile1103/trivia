"use client";

import { useShow } from "@refinedev/core";

import type { CustomerResponse } from "@/api/generated/types.gen";
import { ShowView, ShowViewHeader } from "@/components/refine-ui/views/show-view";
import { Badge } from "@/components/ui/badge";

export function CustomerShow() {
  const { result: record } = useShow<CustomerResponse>({
    resource: "customers",
  });

  return (
    <ShowView>
      <ShowViewHeader />
      <dl className="grid max-w-xl grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
        <dt className="text-muted-foreground">Full name</dt>
        <dd>{record?.fullName ?? "—"}</dd>
        <dt className="text-muted-foreground">Email</dt>
        <dd>{record?.email ?? "—"}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>{record?.status ? <Badge variant="secondary">{record?.status}</Badge> : "—"}</dd>
        <dt className="text-muted-foreground">Credit limit</dt>
        <dd>{record?.creditLimit?.toLocaleString() ?? "—"}</dd>
        <dt className="text-muted-foreground">Created at</dt>
        <dd>{record?.createdAt ? new Date(record?.createdAt).toLocaleString() : "—"}</dd>
      </dl>
    </ShowView>
  );
}
