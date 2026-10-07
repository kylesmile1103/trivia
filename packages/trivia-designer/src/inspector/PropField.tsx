// One prop row: label, setter, reset. Discrete setters (Select, Switch) commit immediately;
// text setters keep typing local and commit on Enter or blur (Onlook's lesson: write on
// commit, never per keystroke) — and when the element is left with a draft, which is a blur
// React never reports (see ./leave). Escape reverts a text setter to the source value.

import { RotateCcw } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { NodeDetails } from '@/bridge/types'
import { cn } from '@/lib/utils'

import type { CommitProp } from './commit'
import { notApplied, selectionLeft, SOURCE_CHANGED } from './leave'
import { formatValue, type Literal, type PropRow, type ReadonlyReason } from './model'

/** Shared grid so labels, setters and reset buttons line up across rows and sections. Every
 *  cell's first line is h-7; a hint (RowHint) takes a second line under the setter. */
export const ROW = 'grid grid-cols-[5.5rem_minmax(0,1fr)_1.5rem] items-start gap-x-2'

const HINTS: Record<ReadonlyReason, string> = {
  expression: 'Bound to an expression — edit in code.',
  element: 'A JSX element — edit in code.',
  mismatch: 'Doesn’t match the declared type — edit in code.',
}

interface PropFieldProps {
  row: PropRow
  /** The details this row was built from; an optimistic value lives until they're replaced. */
  details: NodeDetails
  commit: CommitProp
}

export function PropField({ row, details, commit }: PropFieldProps) {
  const id = useId()
  const [pending, setPending] = useState<{ basis: NodeDetails; value: Literal } | null>(null)
  const optimistic = pending !== null && pending.basis === details ? pending.value : undefined
  const literal = row.value.state === 'literal' ? row.value.value : undefined
  const current = optimistic ?? literal
  const set = current !== undefined

  const write = async (value: Literal | null) => {
    if (value !== null) setPending({ basis: details, value })
    const ok = await commit(row.name, value)
    if (!ok) setPending(null)
    return ok
  }

  let setter: ReactNode
  let hint: string | null = null
  if (row.value.state === 'readonly') {
    setter = <SourceCode source={row.value.source} />
    hint = HINTS[row.value.reason]
  } else if (row.control === null) {
    setter = <SourceCode source={row.schema?.kind === 'unknown' ? row.schema.typeText : 'unknown'} muted />
    hint = 'No setter for this type — set it in code.'
  } else {
    const placeholder = formatValue(row.defaultValue)
    switch (row.control.kind) {
      case 'enum':
        setter = (
          <EnumSetter
            id={id}
            options={row.control.options}
            value={typeof current === 'string' ? current : undefined}
            placeholder={placeholder}
            onCommit={(v) => void write(v)}
          />
        )
        break
      case 'boolean': {
        const fallback = typeof row.defaultValue === 'boolean' ? row.defaultValue : false
        setter = (
          <div className="flex h-7 items-center gap-2">
            <Switch
              id={id}
              size="sm"
              checked={typeof current === 'boolean' ? current : fallback}
              onCheckedChange={(v) => void write(v)}
            />
            {!set && <span className="text-[11px] text-muted-foreground">{row.defaultValue === undefined ? 'unset' : 'default'}</span>}
          </div>
        )
        break
      }
      case 'string':
        setter = (
          <TextSetter
            id={id}
            name={row.name}
            left={() => selectionLeft(details.locator)}
            value={typeof current === 'string' ? current : ''}
            placeholder={placeholder || (set ? '' : 'unset')}
            parse={(text) => ({ ok: true, value: text })}
            onCommit={write}
          />
        )
        break
      case 'number':
        setter = (
          <TextSetter
            id={id}
            name={row.name}
            left={() => selectionLeft(details.locator)}
            type="number"
            value={typeof current === 'number' ? String(current) : ''}
            placeholder={placeholder || 'unset'}
            parse={parseNumber}
            onCommit={write}
          />
        )
        break
    }
  }

  return (
    <div className={ROW}>
      <div className="flex h-7 min-w-0 items-center">
        <PropLabel htmlFor={row.control === null ? undefined : id} row={row} set={set} />
      </div>
      <div className="min-w-0">{setter}</div>
      <div className="flex h-7 items-center justify-end">
        {row.value.state === 'literal' && (
          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Reset ${row.name}`}
                className="text-muted-foreground"
                onClick={() => void write(null)}
              >
                <RotateCcw />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              Remove from source{row.defaultValue === undefined ? '' : ` (default: ${formatValue(row.defaultValue)})`}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {hint !== null && <RowHint>{hint}</RowHint>}
    </div>
  )
}

function PropLabel({ htmlFor, row, set }: { htmlFor: string | undefined; row: PropRow; set: boolean }) {
  const origin = row.schema === null ? 'Written in source; not in the component’s schema' : SOURCE_TEXT[row.schema.source]
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <Label
          htmlFor={htmlFor}
          className={cn('min-w-0 truncate font-mono text-[11px] font-normal', set ? 'text-foreground' : 'text-muted-foreground')}
        >
          {row.name}
        </Label>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-56 flex-col items-start gap-0.5">
        <span className="font-mono">{row.name}</span>
        <span className="opacity-70">{origin}</span>
        {row.defaultValue !== undefined && <span className="opacity-70">Default: {formatValue(row.defaultValue)}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

const SOURCE_TEXT = {
  declared: 'Declared in the component’s props type',
  variant: 'A cva variant',
  intrinsic: 'An attribute of the underlying element',
} as const

/** Read-only source text, h-7 like the setters it stands in for. */
export function SourceCode({ source, muted = false }: { source: string; muted?: boolean }) {
  return (
    <code
      title={source}
      className={cn(
        'block h-7 truncate rounded-md border bg-muted/50 px-2 py-[5px] font-mono text-[11px] leading-4',
        muted && 'text-muted-foreground',
      )}
    >
      {source}
    </code>
  )
}

/** Why a row can't be edited here; sits under the setter column of a ROW grid. */
export function RowHint({ children }: { children: ReactNode }) {
  return <p className="col-span-2 col-start-2 pt-1 pb-0.5 text-[11px] leading-4 text-muted-foreground">{children}</p>
}

interface EnumSetterProps {
  id: string
  options: string[]
  /** undefined while the attribute is absent: the placeholder shows the default. */
  value: string | undefined
  placeholder: string
  onCommit(value: string): void
}

function EnumSetter({ id, options, value, placeholder, onCommit }: EnumSetterProps) {
  // A source value outside the schema's union still has to be visible as the current value.
  const items = value !== undefined && value !== '' && !options.includes(value) ? [...options, value] : options
  return (
    <Select value={value ?? ''} onValueChange={onCommit}>
      <SelectTrigger id={id} size="sm" className="h-7 w-full font-mono text-xs">
        <SelectValue placeholder={placeholder === '' ? 'unset' : placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" className="min-w-(--radix-select-trigger-width)">
        {items.map((option) => (
          <SelectItem key={option} value={option} className="font-mono text-xs">
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

type Parsed = { ok: true; value: Literal } | { ok: false; reason: string }

function parseNumber(text: string): Parsed {
  const trimmed = text.trim()
  const value = Number(trimmed)
  return trimmed !== '' && Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: 'Not a number.' }
}

interface TextSetterProps {
  id: string
  /** The prop, for "not applied" notices. */
  name: string
  /** True once the selection has moved off the element (see ./leave). */
  left(): boolean
  type?: 'text' | 'number'
  /** The source value as text ("" when absent). */
  value: string
  placeholder: string
  parse(text: string): Parsed
  onCommit(value: Literal): Promise<boolean>
}

function TextSetter({ id, name, left, type = 'text', value, placeholder, parse, onCommit }: TextSetterProps) {
  const [draft, setDraft] = useState(value)
  const [base, setBase] = useState(value)
  const [invalid, setInvalid] = useState(false)
  const inFlight = useRef(false)
  // A new source value (after a commit or HMR) replaces the draft.
  if (base !== value) {
    setBase(value)
    setDraft(value)
    setInvalid(false)
  }

  const submit = (revertIfInvalid: boolean) => {
    if (draft === value || inFlight.current) return
    const parsed = parse(draft)
    if (!parsed.ok) {
      if (revertIfInvalid) {
        setDraft(value)
        setInvalid(false)
      } else {
        setInvalid(true)
      }
      return
    }
    inFlight.current = true
    void onCommit(parsed.value).finally(() => {
      inFlight.current = false
    })
  }

  // Unmounting with a draft: commit it when the element is being left, as blur would; otherwise
  // the source changed under the field, and nothing is written over it (see ./leave). Through a
  // ref, so the cleanup sees the last render's draft.
  const unmount = useRef(() => {})
  useLayoutEffect(() => {
    unmount.current = () => {
      if (draft === value || inFlight.current) return
      const parsed = parse(draft)
      if (!left()) notApplied(`${name} “${draft}”`, SOURCE_CHANGED)
      else if (parsed.ok) void onCommit(parsed.value)
      else notApplied(`${name} “${draft}”`, parsed.reason)
    }
  })
  useEffect(() => () => unmount.current(), [])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit(false)
    } else if (event.key === 'Escape' && draft !== value) {
      // Revert only; blurring here would race the blur commit against the reset draft.
      event.preventDefault()
      event.stopPropagation()
      setDraft(value)
      setInvalid(false)
    }
  }

  return (
    <Input
      id={id}
      type={type}
      value={draft}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      spellCheck={false}
      autoComplete="off"
      className="h-7 px-2 text-xs md:text-xs"
      onChange={(event) => {
        setDraft(event.target.value)
        setInvalid(false)
      }}
      onKeyDown={onKeyDown}
      onBlur={() => submit(true)}
    />
  )
}

