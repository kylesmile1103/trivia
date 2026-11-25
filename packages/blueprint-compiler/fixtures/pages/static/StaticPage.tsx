import { Button } from "@/components/ui/button";

export function StaticPage() {
  return (
    <main className="grid  gap-4">
      <h1>Café &amp; ledger</h1>
      <img alt="The &quot;Ledger&quot;" src="/ledger.png" width={96} />
      <Button variant="outline">View &#123;ledger&#125;</Button>
    </main>
  );
}
