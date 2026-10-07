// The className manager: the user-authored tokens as removable chips, plus an input to add
// tokens. Typing previews live in the canvas (two-phase editing); Enter writes the full new
// className through the action bus; Escape cancels. Conflicting utilities replace the token
// they override, in place (see ./classes).

import { X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { Input } from '@/components/ui/input'
import type { NodeDetails } from '@/bridge/types'
import { canvas } from '@/canvas/api'
import { cn } from '@/lib/utils'

import { classValue, mergeClasses, removeClass, splitClasses } from './classes'

interface ClassManagerProps {
  details: NodeDetails
  /** The literal className in source ("" when absent). */
  authored: string
  /** Write the full className (null removes the attribute). */
  commit(value: string | null): Promise<boolean>
}

export function ClassManager({ details, authored, commit }: ClassManagerProps) {
  const locator = details.locator
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  // Tokens just written, shown until the refreshed details replace `details`.
  const [pending, setPending] = useState<{ basis: NodeDetails; tokens: string[] } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const previewing = useRef(false)

  const tokens = pending !== null && pending.basis === details ? pending.tokens : splitClasses(authored)
  const added = splitClasses(draft)
  const next = added.length > 0 ? mergeClasses(tokens, added) : tokens
  const replaced = new Set(tokens.filter((t) => !next.includes(t)))
  const incoming = next.filter((t) => !tokens.includes(t))

  const preview = (value: string | null) => {
    canvas.previewClassName(locator, authored, value)
    previewing.current = value !== null
  }
  const endPreview = () => {
    if (previewing.current) preview(null)
  }

  // Leaving the element (or unmounting) must not strand a preview in the canvas.
  useEffect(
    () => () => {
      if (previewing.current) canvas.clearPreviews()
    },
    [],
  )

  const onDraftChange = (value: string) => {
    setDraft(value)
    const tokensToAdd = splitClasses(value)
    if (tokensToAdd.length === 0) endPreview()
    else preview(mergeClasses(tokens, tokensToAdd).join(' '))
  }

  const write = async (nextTokens: string[]) => {
    setPending({ basis: details, tokens: nextTokens })
    const ok = await commit(classValue(nextTokens))
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
    if (next.join(' ') === tokens.join(' ')) {
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
    await write(removeClass(tokens, token))
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
                onPointerEnter={() => draft === '' && preview(classValue(removeClass(tokens, token)) ?? '')}
                onPointerLeave={() => draft === '' && endPreview()}
                onFocus={() => draft === '' && preview(classValue(removeClass(tokens, token)) ?? '')}
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
          if (added.length > 0) preview(next.join(' '))
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
