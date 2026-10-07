// "Add prop": write any attribute name with a string value. Expressions belong in code; the
// engine renders a string value as `name="value"`. Only Enter (or the check button) adds it:
// leaving the element with the form filled in writes nothing, and says so (see ./leave).

import { Check, Plus } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import type { CommitProp } from './commit'
import { notApplied } from './leave'
import { validatePropName } from './model'
import { ROW } from './PropField'

interface AddPropProps {
  /** Attribute names already on the element. */
  written: ReadonlySet<string>
  commit: CommitProp
}

export function AddProp({ written, commit }: AddPropProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const error = validatePropName(name.trim(), written)

  const unmount = useRef(() => {})
  useLayoutEffect(() => {
    unmount.current = () => {
      if (open && !busy && name.trim() !== '') notApplied(`Prop “${name.trim()}”`, 'Typed without pressing Enter, which adds it.')
    }
  })
  useEffect(() => () => unmount.current(), [])

  const close = () => {
    setOpen(false)
    setName('')
    setValue('')
    setAttempted(false)
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setAttempted(true)
    if (error !== null || busy) return
    setBusy(true)
    const ok = await commit(name.trim(), value)
    setBusy(false)
    if (ok) close()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  if (!open) {
    return (
      <Button variant="ghost" size="xs" className="-ml-2 text-muted-foreground" onClick={() => setOpen(true)}>
        <Plus />
        Add prop
      </Button>
    )
  }

  return (
    <form aria-label="Add prop" className="space-y-1" onSubmit={(event) => void onSubmit(event)} onKeyDown={onKeyDown}>
      <div className={ROW}>
        <Input
          autoFocus
          value={name}
          aria-label="Prop name"
          aria-invalid={(attempted && error !== null) || undefined}
          placeholder="name"
          spellCheck={false}
          autoComplete="off"
          className="h-7 px-2 font-mono text-[11px] md:text-[11px]"
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          value={value}
          aria-label="Prop value"
          placeholder="value"
          spellCheck={false}
          autoComplete="off"
          className="h-7 px-2 text-xs md:text-xs"
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" variant="ghost" size="icon-xs" aria-label="Add" disabled={busy}>
          <Check />
        </Button>
      </div>
      <p className={attempted && error !== null ? 'text-[11px] text-destructive' : 'text-[11px] text-muted-foreground'}>
        {attempted && error !== null ? error : 'Adds a string attribute · Enter to add · Esc to cancel'}
      </p>
    </form>
  )
}
