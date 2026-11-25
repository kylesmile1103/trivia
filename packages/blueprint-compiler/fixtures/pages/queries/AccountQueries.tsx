import { useCustom, useList, useOne } from "@refinedev/core";
import { useState } from "react";
import { useParams, useSearchParams } from "react-router";

import type { AccountDto } from "@/api/generated/types.gen";

export function AccountQueries() {
  const [limit] = useState<number>(20);
  const params = useParams();
  const [searchParams] = useSearchParams();
  const accountsQuery = useList<AccountDto>({ resource: "accounts", pagination: { pageSize: limit }, filters: [{ field: "currency", operator: "eq", value: "USD" }] });
  const statsQuery = useCustom({ url: "/api/v1/accounts/" + encodeURIComponent(String(params.id)) + "/stats", method: "get", config: { query: { from: Object.fromEntries(searchParams).from ?? "" } }, queryOptions: { enabled: params.id !== undefined } });
  const accountQuery = useOne<AccountDto>({ resource: "accounts", id: accountsQuery.result.data[0]?.id, queryOptions: { enabled: (accountsQuery.result.total ?? 0) > 0 } });

  return (
    <main>
      <h1>{accountQuery.result?.iban ?? "No account"}</h1>
      <p>
        {accountsQuery.query.isLoading ? "Loading" : (accountsQuery.result.total ?? 0) + ": " + (statsQuery.result.data?.status ?? "none")}
      </p>
    </main>
  );
}
