import { canvas } from '@/shared/canvas'
import { fillRoute } from '@/shared/lib/route-url'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

import { DialogFrame } from './DialogFrame'
import { Field } from './fields'

export function RouteDialog({ route, params, onClose }: { route: string; params: string[]; onClose(): void }) {
  return (
    <DialogFrame title="Open page" description={route} onClose={onClose}>
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault()
        const fields = new FormData(event.currentTarget)
        const url = fillRoute(route, Object.fromEntries(params.map((param) => [param, String(fields.get('param-' + param) ?? '')])))
        if (url) {
          canvas.navigate(url)
          onClose()
        }
      }}>
        {params.map((param) => <Field key={param} label={param}>{(id) => <Input id={id} name={'param-' + param} required />}</Field>)}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm">Open route</Button>
        </div>
      </form>
    </DialogFrame>
  )
}
