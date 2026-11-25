import { useState } from "react";

import { Input } from "@/components/ui/input";

export function SearchPanel() {
  const [prefix] = useState<string>("Search");
  const [searchValue, setSearchValue] = useState<string>("seed");

  return (
    <main>
      <Input
        onChange={(event) => setSearchValue(event.target.value)}
        placeholder="Type"
        value={searchValue}
      />
      <p>{prefix + ": " + searchValue}</p>
    </main>
  );
}
