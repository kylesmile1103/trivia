import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/** A customer as the API returns it. */
type Customer = {
  id: string
  name: string
  email: string
  plan: "free" | "pro"
}

/**
 * Formats the plan for display.
 * @param plan - the customer's plan
 */
function planLabel(plan: Customer["plan"]): string {
  return plan === "pro" ? "Pro" : "Free"
}


// Two blank lines above on purpose: formatting the user chose must survive.
function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
}

/**
 * Shows one customer.
 *
 * @example <CustomerCard customer={c} />
 */
export function CustomerCard({ customer }: { customer: Customer }) {
  return (
    <Card
      className="w-full max-w-sm"
      data-customer={customer.id}
    >
      <CardHeader>
        <CardTitle>
          {initials(customer.name)} · {customer.name}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {/* TODO: Add badge */}
        <p className="text-sm text-muted-foreground">{customer.email}</p>
        <Badge
          variant={customer.plan === "pro" ? "default" : "secondary"}
        >
          {planLabel(customer.plan)}
        </Badge>
      </CardContent>
    </Card>
  )
}
