import { useState } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";

export function AccountCard() {
  const [labels] = useState<string[]>(["Savings", "Credit"]);
  const [visible] = useState<boolean>(true);

  return (
    <Card size="sm">
      <CardHeader>
        <h2>Accounts</h2>
      </CardHeader>
      <CardContent>
        {Boolean(visible) && (
          <p>Active accounts</p>
        )}
        <ul>
          {(labels).map((_label, _index) => (
            Boolean(_label !== "") && (
              <li key={_label}>{_label + " #" + _index}</li>
            )
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
