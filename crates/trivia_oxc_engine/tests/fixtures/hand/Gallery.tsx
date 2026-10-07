import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Component, Fragment } from "react"
import * as Icons from "lucide-react"

type Item = { id: string; label: string; done: boolean }

// Several components per file: each is its own locator scope.
export function Gallery({ items, open }: { items: Item[]; open: boolean }) {
  if (!items.length) {
    return <p className="empty">Nothing here — 空っぽ 🎉</p>
  }
  return (
    <>
      <header className="flex items-center gap-2">
        <h1>Gallery ✨ 画廊</h1>
        <Badge variant='outline'>{items.length}</Badge>
      </header>
      {open && <Card className="open">Open</Card>}
      <ul>
        {items.map((item) => (
          <li key={item.id} data-done={item.done}>
            {item.label}
          </li>
        ))}
      </ul>
      <Button
        variant="ghost"
        size="sm" // compact
        disabled
        tabIndex={-1}
        {...{ "aria-label": "close" }}
      >
        <Icons.X />
      </Button>
      <Button icon={<Icons.Plus />} variant="outline" /* first */ variant="secondary">
        Add
      </Button>
      <p>Hello <b>world</b>, Tom &amp; Jerry</p>
      <div></div>
      <div>
      </div>
      <section title="a &amp; b" data-count={3} data-ratio={1.5} hidden={false} />
      <Fragment key="f">
        <span>{"quoted"}</span>
        <span title={'single'} className={`static`} data-n={ 7 } />
      </Fragment>
    </>
  )
}

export const Toolbar = ({ rest }: { rest: object }) => (
  <div role="toolbar" className={buttonVariants({ variant: "link" })}>
    <Button {...rest} variant="link">Link</Button>
    <CardContent>
      {/* only a comment */}
    </CardContent>
  </div>
)

export class Legacy extends Component<{ title: string }> {
  render() {
    return (
      <Card>
        <CardContent title={this.props.title}>Legacy</CardContent>
      </Card>
    )
  }
}

function Code() {
  return (
    <pre>
      <code>{`line one
  line two`}</code>
      <span data-note="spans
two lines">x</span>
    </pre>
  )
}

export default Code
