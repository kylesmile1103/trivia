import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

const plans = ["Hobby", "Pro", "Team"]

/** Same element tree as Dashboard.tsx, laid out very differently. */
export function Dashboard() {
  // Comments and blank lines everywhere.

  return <div className="mx-auto grid max-w-3xl gap-6"><Card>
    <CardHeader><CardTitle>Project settings</CardTitle>


      <CardDescription>
        Changes are saved to your source files.
      </CardDescription></CardHeader>
    <CardContent
      className="grid gap-4"
    >
      {/* name field */}
      {/* another comment */}
      <div className="grid gap-2"><Label htmlFor="name">Project name</Label><Input id="name" placeholder="my-app"/></div>

      <div className="flex items-center justify-between">
        <Label htmlFor="public">Public</Label>  <Switch id="public" />
      </div>
      <div className="flex gap-2">{plans.map((plan) => <Badge key={plan} variant="secondary">{plan}</Badge>)}</div>
    </CardContent>
    <CardFooter className="justify-end gap-2"><Button variant="ghost">Cancel</Button>
      <Button>Save changes</Button></CardFooter>
  </Card></div>
}
