// Compact building blocks of the style panel: sections, labelled rows, a numeric field with a
// Figma-style scrub handle, and a slider that previews while dragging and commits on release.

import { cn } from 'cn'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'

import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatNumber } from '@/lib/tailwind'

/**
 * Segmented-control item look. Keyed on ARIA state, not `data-state`: wrapping an item in a
 * Tooltip trigger replaces its `data-state` with the tooltip's.
 */
export const SEGMENT_ITEM =
  'text-muted-foreground hover:text-foreground aria-checked:bg-foreground/10 aria-checked:text-foreground aria-pressed:bg-foreground/10 aria-pressed:text-foreground'

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-b px-3 py-3 last:border-b-0">
      <div className="flex h-6 items-center justify-between">
        <h3 id={id} className="text-xs font-medium text-foreground">
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

/** A labelled control row: fixed label column, controls fill the rest. */
export function Row({ label, hint, children }: { label: string; hint?: string | null; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2">
      <span className="w-14 shrink-0 truncate text-xs text-muted-foreground" title={hint ? `${label}: ${hint}` : label}>
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  )
}

/** The class a control currently reads from, in mono (`p-4`). */
export function TokenHint({ token, className }: { token: string | null | undefined; className?: string }) {
  if (!token) return null
  return (
    <code className={cn('shrink-0 truncate rounded bg-muted px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground', className)}>
      {token}
    </code>
  )
}

const NUMBER_WITH_UNIT = /^(-?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)$/i
/** Screen pixels of pointer travel per scrub step. */
const SCRUB_PX_PER_STEP = 4

export interface ScrubFieldProps {
  /** Accessible name ("Padding top"). */
  label: string
  /** Visible handle (icon or letters); dragging it scrubs the value. */
  handle: ReactNode
  /** Number shown (px, %), or null when unset or not numeric. */
  value: number | null
  /** Shown when `value` is null: "Mixed", "auto", "var(--gap)". */
  text?: string | null
  /** Muted hint when nothing is set (the computed value). */
  placeholder?: string
  unit?: string
  step: number
  min?: number
  max?: number
  /** Tooltip detail: the class and its CSS value. */
  hint?: string | null
  /** A gesture (scrub, arrow keys, typing) moved the value: preview it. */
  onChange(value: number): void
  /** The gesture ended (release, Enter, blur): commit it. */
  onCommit(value: number): void
  /** Enter/blur with typed text that is not a plain number in `unit` ("1.5rem", "auto"). */
  onCommitText(text: string): void
  /** Enter/blur with an empty field: remove the utility. */
  onClear(): void
  /** Escape, or a scrub that ended where it started: drop the preview. */
  onCancel(): void
  className?: string
}

export function ScrubField(props: ScrubFieldProps) {
  const { label, handle, value, text, placeholder, unit, step, min, max, hint, className } = props
  const inputRef = useRef<HTMLInputElement>(null)
  // `draft`: text typed but not submitted. `moved`: value moved by keys/scrub, not submitted.
  // Mirrored in refs: Escape blurs the input synchronously, and the blur handler must see the
  // reset, not the values of the last render.
  const [draft, setDraftState] = useState<string | null>(null)
  const [moved, setMovedState] = useState<number | null>(null)
  const draftRef = useRef<string | null>(null)
  const movedRef = useRef<number | null>(null)
  const scrub = useRef<{ pointerId: number; startX: number; start: number; last: number } | null>(null)

  const setDraft = (v: string | null) => {
    draftRef.current = v
    setDraftState(v)
  }
  const setMoved = (v: number | null) => {
    movedRef.current = v
    setMovedState(v)
  }
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
  const asNumber = (t: string): number | null => {
    const m = NUMBER_WITH_UNIT.exec(t.trim())
    return m && (m[2] === '' || m[2]?.toLowerCase() === unit) ? clamp(Number(m[1])) : null
  }
  const base = () => movedRef.current ?? value ?? (placeholder !== undefined ? numberOf(placeholder) : null) ?? 0
  const shown = draft ?? (moved !== null ? formatNumber(moved) : value !== null ? formatNumber(value) : (text ?? ''))

  const move = (n: number) => {
    setMoved(n)
    props.onChange(n)
  }
  const reset = () => {
    setDraft(null)
    setMoved(null)
  }
  const submit = () => {
    const typed = draftRef.current
    const nudged = movedRef.current
    reset()
    if (typed !== null) {
      const t = typed.trim()
      const n = asNumber(t)
      if (t === '') props.onClear()
      else if (n !== null) props.onCommit(n)
      else props.onCommitText(t)
    } else if (nudged !== null) {
      props.onCommit(nudged)
    }
  }
  const cancel = () => {
    const active = draftRef.current !== null || movedRef.current !== null || scrub.current !== null
    reset()
    scrub.current = null
    if (active) props.onCancel()
  }

  return (
    <div
      className={cn(
        'group/field flex h-7 min-w-0 items-center rounded-md border border-input bg-transparent transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 dark:bg-input/30',
        className,
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-hidden
            className="flex h-full w-6 shrink-0 cursor-ew-resize touch-none items-center justify-center text-[10px] font-medium text-muted-foreground select-none group-focus-within/field:text-foreground hover:text-foreground [&_svg]:size-3.5"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.preventDefault()
              e.currentTarget.setPointerCapture(e.pointerId)
              const start = base()
              scrub.current = { pointerId: e.pointerId, startX: e.clientX, start, last: start }
            }}
            onPointerMove={(e) => {
              const s = scrub.current
              if (!s || s.pointerId !== e.pointerId) return
              const steps = Math.round((e.clientX - s.startX) / SCRUB_PX_PER_STEP)
              const next = clamp(s.start + steps * step * (e.altKey ? 0.5 : 1))
              if (next !== s.last) {
                s.last = next
                move(next)
              }
            }}
            onPointerUp={(e) => {
              const s = scrub.current
              if (!s || s.pointerId !== e.pointerId) return
              scrub.current = null
              e.currentTarget.releasePointerCapture(e.pointerId)
              if (s.last !== s.start) {
                reset()
                props.onCommit(s.last)
              } else {
                if (movedRef.current !== null) cancel()
                inputRef.current?.focus()
              }
            }}
            onPointerCancel={cancel}
          >
            {handle}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{hint ? `${label} · ${hint}` : label}</TooltipContent>
      </Tooltip>
      <input
        ref={inputRef}
        aria-label={label}
        // size=1: no intrinsic width, so the field never widens the panel (Radix ScrollArea
        // lays its content out at max-content width).
        size={1}
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        className="h-full w-full min-w-0 bg-transparent pr-1 text-xs tabular-nums outline-none placeholder:text-muted-foreground/70"
        value={shown}
        placeholder={placeholder}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = asNumber(e.target.value)
          if (n !== null) props.onChange(n)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
            e.currentTarget.blur()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const factor = (e.shiftKey ? 4 : 1) * (e.altKey ? 0.5 : 1) * (e.key === 'ArrowUp' ? 1 : -1)
            setDraft(null)
            move(clamp(base() + step * factor))
          }
        }}
        onBlur={submit}
      />
      {unit && <span className="pr-1.5 text-[10px] text-muted-foreground select-none">{unit}</span>}
    </div>
  )
}

export interface ScrubSliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange(value: number): void
  onCommit(value: number): void
  onCancel(): void
  className?: string
}

/** Keyboard changes settle this long before they are written (one write per burst of keys). */
const KEYBOARD_COMMIT_DELAY_MS = 450

/**
 * Previews while dragging, commits once on release. Radix commits on every arrow key; those
 * commits are coalesced so holding a key writes the file once.
 */
export function ScrubSlider({ label, value, min, max, step, onChange, onCommit, onCancel, className }: ScrubSliderProps) {
  const dragging = useRef(false)
  const committed = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingKey = useRef<number | null>(null)

  const flush = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    const v = pendingKey.current
    pendingKey.current = null
    if (v !== null) onCommit(v)
  }
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  return (
    <Slider
      // Radix names the thumb (the focusable role="slider") only from Thumb props, which the
      // shadcn Slider does not expose; label it directly.
      ref={(root: HTMLSpanElement | null) => root?.querySelector('[role="slider"]')?.setAttribute('aria-label', label)}
      className={cn('min-w-0 flex-1', className)}
      min={min}
      max={max}
      step={step}
      value={[Math.min(max, Math.max(min, value))]}
      onPointerDown={() => {
        dragging.current = true
        committed.current = false
      }}
      onPointerUp={() => {
        // Radix commits from its own pointerup (after this handler) and only when the value
        // changed; a drag that ends where it started must still drop its preview.
        setTimeout(() => {
          dragging.current = false
          if (!committed.current) onCancel()
        })
      }}
      onValueChange={([v]) => {
        if (v !== undefined) onChange(v)
      }}
      onValueCommit={([v]) => {
        if (v === undefined) return
        committed.current = true
        if (dragging.current) {
          onCommit(v)
          return
        }
        pendingKey.current = v
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(flush, KEYBOARD_COMMIT_DELAY_MS)
      }}
      onBlur={flush}
    />
  )
}

function numberOf(text: string): number | null {
  const n = Number.parseFloat(text)
  return Number.isFinite(n) ? n : null
}
