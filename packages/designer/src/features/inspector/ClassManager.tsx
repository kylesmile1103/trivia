// The className manager: the user-authored tokens as removable chips, plus an input to add
// tokens. Typing previews live in the canvas (two-phase editing); Enter writes the new
// className through the action bus; Escape cancels.
//
// Every write is the authored string with only the touched tokens changed (lib/tailwind's
// mergeClassName / removeClasses), so a multi-line className keeps its line breaks and
// indentation. A conflicting addition replaces the token it overrides in place, unless a later
// authored token would override the addition in turn under a component's own
// `cn(base, className)` (later wins); then it is appended, so it takes effect either way.
//
// Typed classes are applied only by Enter: blur — including leaving the element, when the
// selection moves on — never writes a half-typed token. Leaving with classes typed but not
// applied says so in a toast instead of dropping them silently.

import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

import { canvas } from '@/shared/canvas'
import type { NodeDetails } from '@/shared/engine/types'
import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/input'

import { notApplied } from './leave'
import { mergeClassName, removeClasses, splitClassName } from './tailwind'

interface ClassManagerProps {
  details: NodeDetails
  /** The literal className in source ("" when absent). */
  authored: string
  /** Write the full className (null removes the attribute). */
  commit(value: string | null): Promise<boolean>
}

/** The value to write: null (remove the attribute) when no class is left — an empty
 *  `className=""` is noise in the user's source. */
function attributeValue(className: string): string | null {
  return splitClassName(className).length > 0 ? className : null
}

/**
 * `current` with the typed classes added. A typed class that is already there is ignored
 * rather than re-asserted: as an addition, `p-4` would also drop an authored `px-2` before it,
 * which still wins on a plain element (Tailwind orders `px-*` after `p-*`).
 */
function withClasses(current: string, tokens: readonly string[], typed: readonly string[]): string {
  const fresh = typed.filter((t) => !tokens.includes(t))
  return fresh.length > 0 ? mergeClassName(current, fresh) : current
}

export function ClassManager({ details, authored, commit }: ClassManagerProps) {
  const locator = details.locator
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  // The className just written, shown until the refreshed details replace `details`.
  const [pending, setPending] = useState<{ basis: NodeDetails; value: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const previewing = useRef(false)

  const current = pending !== null && pending.basis === details ? pending.value : authored
  const tokens = splitClassName(current)
  const added = splitClassName(draft)
  const next = withClasses(current, tokens, added)
  const nextTokens = splitClassName(next)
  const replaced = new Set(tokens.filter((t) => !nextTokens.includes(t)))
  const incoming = nextTokens.filter((t) => !tokens.includes(t))

  const preview = (value: string | null) => {
    canvas.previewClassName(locator, authored, value)
    previewing.current = value !== null
  }
  const endPreview = () => {
    if (previewing.current) preview(null)
  }

  // Leaving the element (or unmounting) must not strand a preview in the canvas, nor drop
  // typed classes without a word. Through a ref: the cleanup must see the last render's draft.
  const leave = useRef(() => {})
  useLayoutEffect(() => {
    leave.current = () => {
      if (previewing.current) canvas.clearPreviews()
      if (added.length > 0 && next !== current) {
        notApplied(`Classes “${added.join(' ')}” on <${details.name}>`, 'Typed without pressing Enter, which applies classes.')
      }
    }
  })
  useEffect(() => () => leave.current(), [])

  const onDraftChange = (value: string) => {
    setDraft(value)
    const tokensToAdd = splitClassName(value)
    if (tokensToAdd.length === 0) endPreview()
    else preview(withClasses(current, tokens, tokensToAdd))
  }

  const write = async (value: string) => {
    setPending({ basis: details, value })
    const ok = await commit(attributeValue(value))
    // The file is written (or the edit refused); HMR brings the real classes from here.
    canvas.clearPreviews()
    previewing.current = false
    if (!ok) setPending(null)
    return ok
  }

  const submit = async () => {
    if (added.length === 0) return
    const typed = draft
    setDraft('')
    if (next === current) {
      // Every token is already there: nothing to write.
      canvas.clearPreviews()
      previewing.current = false
      return
    }
    if (!(await write(next))) setDraft(typed)
  }

  const cancel = () => {
    setDraft('')
    canvas.clearPreviews()
    previewing.current = false
  }

  const remove = async (token: string, viaKeyboard: boolean) => {
    endPreview()
    await write(removeClasses(current, [token]))
    // The chip (and its focused button) is gone; keep keyboard users in the manager.
    if (viaKeyboard) inputRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape' && draft !== '') {
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
  }

  return (
    <div className="space-y-2">
      {tokens.length > 0 || incoming.length > 0 ? (
        <ul aria-label="Classes" className="flex flex-wrap gap-1">
          {tokens.map((token, index) => (
            <li
              // Authored classNames may repeat a token; position keeps keys unique.
              key={`${index}:${token}`}
              className={cn(
                'inline-flex h-6 max-w-full items-center gap-0.5 rounded-md border bg-muted/40 pr-0.5 pl-1.5 font-mono text-[11px]',
                replaced.has(token) && 'text-muted-foreground line-through opacity-60',
              )}
            >
              <span className="truncate">{token}</span>
              <button
                type="button"
                aria-label={`Remove class ${token}`}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                onPointerEnter={() => draft === '' && preview(removeClasses(current, [token]))}
                onPointerLeave={() => draft === '' && endPreview()}
                onFocus={() => draft === '' && preview(removeClasses(current, [token]))}
                onBlur={() => draft === '' && endPreview()}
                onClick={(event) => void remove(token, event.detail === 0)}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
          {incoming.map((token) => (
            <li
              key={`+${token}`}
              className="inline-flex h-6 max-w-full items-center rounded-md border border-dashed border-ring px-1.5 font-mono text-[11px]"
            >
              <span className="truncate">{token}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">No classes in source.</p>
      )}
      <Input
        ref={inputRef}
        value={draft}
        aria-label="Add classes"
        placeholder="Add classes…"
        spellCheck={false}
        autoComplete="off"
        className="h-7 px-2 font-mono text-xs md:text-xs"
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          setFocused(true)
          if (added.length > 0) preview(next)
        }}
        onBlur={() => {
          // Keep the typed text, drop the preview: blur is not a commit for class tokens.
          setFocused(false)
          endPreview()
        }}
      />
      {added.length > 0 && (
        <p className="text-[11px] leading-4 text-muted-foreground">
          {replaced.size > 0 ? `Replaces ${[...replaced].join(', ')}. ` : ''}
          {focused ? 'Enter to apply · Esc to cancel' : 'Not applied — press Enter in the field to apply.'}
        </p>
      )}
    </div>
  )
}
