import { useId, useState, type ComponentProps, type ReactNode } from 'react'

import type { JsonValue } from '@/shared/engine/types'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'

export function Field({ label, children }: { label: string; children(id: string): ReactNode }) {
  const id = useId()
  return <div className="grid min-w-0 gap-1.5"><Label htmlFor={id}>{label}</Label>{children(id)}</div>
}

export const selectClass = 'h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

export function CommitInput({ value, commit, ...props }: Omit<ComponentProps<typeof Input>, 'value' | 'defaultValue'> & {
  value: string
  commit(value: string): void
}) {
  return (
    <Input
      key={value} defaultValue={value} {...props}
      onBlur={(event) => {
        if (event.currentTarget.value !== value) commit(event.currentTarget.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.currentTarget.value = value
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault()
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export function JsonField({ label, pointer, value, array = false, object = false, save }: {
  label: string
  pointer: string
  value?: JsonValue
  array?: boolean
  object?: boolean
  save(value: JsonValue): void
}) {
  const source = value === undefined ? '' : JSON.stringify(value, null, 2)
  const [edited, setEdited] = useState<{ source: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const text = edited?.source === source ? edited.text : source
  function apply() {
    let parsed: JsonValue
    try {
      parsed = JSON.parse(text) as JsonValue
    } catch {
      setError('Enter valid JSON.')
      return
    }
    if (array && !Array.isArray(parsed)) {
      setError('Enter a JSON array.')
      return
    }
    if (object && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
      setError('Enter a JSON object.')
      return
    }
    setError(null)
    save(parsed)
  }
  return (
    <div className="space-y-1.5">
      <Field label={label}>{(id) => (
        <>
          <textarea
            id={id} data-pointer={pointer} rows={3} value={text} spellCheck={false}
            aria-invalid={error !== null} aria-describedby={error ? id + '-error' : undefined}
            className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => { setEdited({ source, text: event.target.value }); setError(null) }}
          />
          {error && <p id={id + '-error'} role="alert" className="text-xs text-destructive">{error}</p>}
        </>
      )}</Field>
      <Button type="button" size="xs" variant="outline" disabled={text === source} onClick={apply}>Save {label.toLowerCase()}</Button>
    </div>
  )
}
