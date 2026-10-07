// The style panel's editing model: what the controls show (the className parsed, plus the
// canvas element's computed style for unset values) and the two ways they change it.
//
// Two-phase editing (CLAUDE.md, Onlook notes): while a gesture runs, `preview` sends real CSS
// to the canvas — Tailwind JIT has no CSS yet for classes that are not in the source, so a
// class preview of a new value would show nothing. On release, `commitStyle` converts the
// same declarations to Tailwind classes, merges them into the className (tailwind-merge
// rules, unrelated tokens untouched) and hands the new className to the embedder, which
// writes it through the action bus; the preview is cleared once the canvas shows the commit
// (usePreview). Nothing here writes `style={{…}}`.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { canvas } from '@/canvas/api'
import {
  declarationsToTailwind,
  mergeClassName,
  parse,
  removeUtilities,
  SCALE_ONLY_THEME,
  type StyleState,
  TailwindConversionError,
  type Utility,
} from '@/lib/tailwind'
import { designer, useDesigner } from '@/state/store'

/**
 * Lengths map onto the spacing scale only. Radius and font-size tokens depend on the project's
 * theme (shadcn redefines `rounded-lg`), so the panel offers them by name and writes typed
 * lengths exactly (`rounded-[10px]`).
 */
export const PANEL_THEME = SCALE_ONLY_THEME

/** CSS declarations, kebab-case property → value. */
export type Declarations = Record<string, string>

export interface StyleEditorProps {
  locator: string
  className: string
  onPreview(style: Declarations | null): void
  onCommit(className: string, label?: string): void | Promise<unknown>
}

export interface StyleEditor {
  locator: string
  /** The className the controls show: the committed one until the embedder catches up. */
  className: string
  state: StyleState
  /** Computed values of the canvas element (px strings etc.), for placeholders. */
  computed: Readonly<Record<string, string>>
  /** Live canvas preview during a gesture; null clears it. */
  preview(style: Declarations | null): void
  /** Convert declarations to classes and commit. False (and a toast) when they don't convert. */
  commitStyle(style: Declarations, label: string): boolean
  /** Commit named utilities as they are (`rounded-lg`, `text-sm`). */
  commitClasses(classes: readonly string[], label: string): void
  /** Remove the base tokens of these utilities. */
  clear(utilities: readonly Utility[], label: string): void
}

export const StyleEditorContext = createContext<StyleEditor | null>(null)

export function useEditor(): StyleEditor {
  const editor = useContext(StyleEditorContext)
  if (!editor) throw new Error('style controls must be rendered inside <StylePanel>')
  return editor
}

interface Pending {
  /** props.className when the commit was made. */
  base: string
  next: string
}

/** Longest a committed preview waits for the canvas to show the commit (see usePreview). */
const PREVIEW_HOLD_MS = 1500

export function useStyleEditor({ locator, className, onPreview, onCommit }: StyleEditorProps): StyleEditor {
  // Between a commit and the embedder's refreshed details, show what was committed rather
  // than snapping back to the old value. Dropped as soon as props.className moves (refresh,
  // undo, a hand edit) or the commit reports failure.
  const [pending, setPending] = useState<Pending | null>(null)
  const [seen, setSeen] = useState(className)
  if (seen !== className) {
    // Adjusting state while rendering (react.dev "storing information from previous renders").
    setSeen(className)
    setPending(null)
  }
  const current = pending !== null && pending.base === className ? pending.next : className

  const state = useMemo(() => parse(current, PANEL_THEME), [current])
  const computed = useComputedStyle(locator, current)
  const { preview, clearAfterRender } = usePreview(onPreview)

  const write = useCallback(
    (next: string, label: string) => {
      if (next === current) {
        preview(null)
        return
      }
      const settle = clearAfterRender()
      const entry: Pending = { base: className, next }
      setPending(entry)
      const result = onCommit(next, label)
      if (isPromiseLike(result)) {
        const failed = () => {
          setPending((p) => (p === entry ? null : p))
          settle()
        }
        result.then((value) => {
          if (value === null || value === false) failed()
        }, failed)
      }
    },
    [className, current, onCommit, preview, clearAfterRender],
  )

  return useMemo<StyleEditor>(
    () => ({
      locator,
      className: current,
      state,
      computed,
      preview,
      commitStyle(style, label) {
        let classes: string[]
        try {
          classes = declarationsToTailwind(style, PANEL_THEME)
        } catch (error) {
          preview(null)
          if (!(error instanceof TailwindConversionError)) throw error
          toast.error(error.message)
          return false
        }
        write(mergeClassName(current, classes), `${label} ${classes.join(' ')}`)
        return true
      },
      commitClasses(classes, label) {
        write(mergeClassName(current, classes), `${label} ${classes.join(' ')}`)
      },
      clear(utilities, label) {
        write(removeUtilities(current, utilities, PANEL_THEME), `Clear ${label.toLowerCase()}`)
      },
    }),
    [locator, current, state, computed, preview, write],
  )
}

/**
 * Preview plumbing. A commit clears the preview only once the canvas has re-rendered with it
 * (the store's `revision` moves after HMR), so the element does not flash back to its old
 * style during the write → HMR round trip. Cancelling, a failed commit, a new gesture or
 * PREVIEW_HOLD_MS without a re-render clear it at once.
 */
function usePreview(onPreview: (style: Declarations | null) => void) {
  const revision = useDesigner((s) => s.revision)
  const active = useRef(false)
  const hold = useRef<{ revision: number; timer: ReturnType<typeof setTimeout> } | null>(null)

  const preview = useCallback(
    (style: Declarations | null) => {
      if (hold.current) clearTimeout(hold.current.timer)
      hold.current = null
      active.current = style !== null
      onPreview(style)
    },
    [onPreview],
  )

  /** Start holding the current preview; returns "clear it now if still held". */
  const clearAfterRender = useCallback((): (() => void) => {
    if (!active.current) return () => {}
    if (hold.current) clearTimeout(hold.current.timer)
    const entry = { revision: designer.getState().revision, timer: setTimeout(() => preview(null), PREVIEW_HOLD_MS) }
    hold.current = entry
    return () => {
      if (hold.current === entry) preview(null)
    }
  }, [preview])

  useEffect(() => {
    if (hold.current && revision > hold.current.revision) preview(null)
  }, [revision, preview])

  // Unmount (new selection): never leave a preview behind. Through a ref, so an embedder
  // passing a fresh `onPreview` each render does not clear a running gesture.
  const latest = useRef(onPreview)
  useLayoutEffect(() => {
    latest.current = onPreview
  })
  useEffect(
    () => () => {
      if (hold.current) clearTimeout(hold.current.timer)
      if (active.current) latest.current(null)
    },
    [],
  )

  return { preview, clearAfterRender }
}

// Computed properties the controls use as placeholders when the className leaves them unset
// (e.g. padding that comes from the component's own classes).
const COMPUTED = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'row-gap',
  'column-gap',
  'display',
  'flex-direction',
  'width',
  'height',
  'border-top-left-radius',
  'font-size',
  'font-weight',
  'opacity',
] as const

function useComputedStyle(locator: string, className: string): Readonly<Record<string, string>> {
  // The canvas bumps `revision` after HMR re-renders the iframe. The DOM is read while rendering
  // (a plain read of another document, keyed by everything that can change it) rather than in
  // an effect, which would cost a second render per change.
  const revision = useDesigner((s) => s.revision)
  return useMemo(() => {
    const element = canvas.elements(locator)[0]
    const view = element?.ownerDocument.defaultView
    if (!element || !view) return {}
    const style = view.getComputedStyle(element)
    return Object.fromEntries(COMPUTED.map((p) => [p, style.getPropertyValue(p)]))
    // className and revision are the cache key: they change what the DOM read returns.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [locator, className, revision])
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}
