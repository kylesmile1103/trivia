import { useCreate, useCustomMutation, useDelete, useGo, useList, useNotification, useUpdate } from "@refinedev/core";
import { useState } from "react";

import type { CustomerDto } from "@/api/generated/types.gen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { audit as callAudit } from "../../handlers/AccountActions";

export function AccountActions() {
  const [message, setMessage] = useState<string>("");
  const [searchValue, setSearchValue] = useState<string>("");
  const customersQuery = useList<CustomerDto>({ resource: "customers" });
  const createRecord = useCreate();
  const updateRecord = useUpdate();
  const deleteRecord = useDelete();
  const mutateCustom = useCustomMutation();
  const go = useGo();
  const notification = useNotification();

  async function handleSearchOnChange(_event: import("react").ChangeEvent<HTMLInputElement>, _value = _event.target.value) {
    setSearchValue(_event.target.value);
    setMessage(_value);
  }

  async function handleSendOnClick(_event: import("react").MouseEvent<HTMLButtonElement>, _value = _event) {
    await createRecord.mutateAsync({ resource: "customers", values: { name: message } });
    await updateRecord.mutateAsync({ resource: "customers", id: "c1", values: { name: message } });
    await deleteRecord.mutateAsync({ resource: "customers", id: "c2" });
    await mutateCustom.mutateAsync({ url: "/api/v1/accounts/" + encodeURIComponent(String("a1")) + "/close", method: "post", values: {} });
    await customersQuery.query.refetch();
    notification.open?.({ type: "success", message: "Saved" });
    await callAudit({ event: _event, state: { message }, setters: { message: setMessage } });
    go({ to: "/customers" });
  }

  return (
    <main>
      <Input
        onChange={(event) => void handleSearchOnChange(event).catch(console.error)}
        value={searchValue}
      />
      <Button onClick={(event) => void handleSendOnClick(event).catch(console.error)}>Save</Button>
    </main>
  );
}
