// A minimal CanvasApi over the harness iframe, so the style panel can be exercised before (and
// independently of) the real canvas. Previews live in one override stylesheet inside the
// iframe (the Onlook approach): React re-renders and HMR leave it alone, and clearing it
// restores the page exactly.

import type { CanvasApi } from '@/shared/canvas'

const PREVIEW_STYLE_ID = 'trivia-style-preview'
const SELECTION_STYLE_ID = 'trivia-harness-selection'
const PROPERTY = /^-?[a-z][a-z-]*$/
const UNSAFE_VALUE = /[;{}<>]/

export interface HarnessCanvas extends CanvasApi {
  /** Outline the selected element (harness only; not part of CanvasApi). */
  highlight(locator: string | null): void
  /** Re-apply previews and the outline after the iframe navigated or reloaded. */
  reattach(): void
}

export function nodeSelector(locator: string): string {
  return `[data-ast-node="${CSS.escape(locator)}"]`
}

export function createHarnessCanvas(frame: HTMLIFrameElement): HarnessCanvas {
  const styles = new Map<string, Record<string, string>>()
  const classes = new Map<HTMLElement, string>() // element → className before its preview
  let selected: string | null = null

  const doc = () => frame.contentDocument

  const sheet = (id: string): HTMLStyleElement | null => {
    const d = doc()
    if (!d?.head) return null
    const existing = d.getElementById(id)
    if (existing?.tagName === 'STYLE') return existing as HTMLStyleElement
    const el = d.createElement('style')
    el.id = id
    d.head.append(el)
    return el
  }

  const renderPreviews = () => {
    const el = sheet(PREVIEW_STYLE_ID)
    if (!el) return
    el.textContent = [...styles]
      .map(([locator, declarations]) => {
        const body = Object.entries(declarations)
          .map(([property, value]) => `${property}: ${value} !important;`)
          .join(' ')
        return `${nodeSelector(locator)} { ${body} }`
      })
      .join('\n')
  }

  const renderSelection = () => {
    const el = sheet(SELECTION_STYLE_ID)
    if (!el) return
    el.textContent = selected
      ? `${nodeSelector(selected)} { outline: 1.5px solid oklch(0.62 0.19 259) !important; outline-offset: 1px !important; }`
      : ''
  }

  const elements = (locator: string): HTMLElement[] => {
    const d = doc()
    // The iframe is another realm: check against its own HTMLElement, not the designer's.
    const view = d?.defaultView
    if (!d || !view) return []
    return [...d.querySelectorAll(nodeSelector(locator))].filter((n): n is HTMLElement => n instanceof view.HTMLElement)
  }

  return {
    elements,
    layers: () => [], // the harness has no layers panel, so nothing moves through it
    version: () => 0,
    moveRefusal: () => 'the style harness does not move elements',
    move: async () => {},
    moveStep: async () => {},
    capture: async () => null,

    previewClassName(locator, previous, next) {
      for (const el of elements(locator)) {
        if (next === null) {
          const original = classes.get(el)
          if (original !== undefined) el.className = original
          classes.delete(el)
          continue
        }
        if (!classes.has(el)) classes.set(el, el.className)
        const drop = new Set(previous.split(/\s+/).filter(Boolean))
        const kept = (classes.get(el) ?? '').split(/\s+/).filter((t) => t && !drop.has(t))
        el.className = [...kept, ...next.split(/\s+/).filter(Boolean)].join(' ')
      }
    },

    previewStyle(locator, style) {
      if (style === null) {
        styles.delete(locator)
      } else {
        for (const [property, value] of Object.entries(style)) {
          if (!PROPERTY.test(property) || UNSAFE_VALUE.test(value)) {
            throw new Error(`refusing to preview ${property}: ${value}`)
          }
        }
        styles.set(locator, { ...style })
      }
      renderPreviews()
    },

    clearPreviews() {
      styles.clear()
      for (const [el, original] of classes) el.className = original
      classes.clear()
      renderPreviews()
    },

    highlight(locator) {
      selected = locator
      renderSelection()
    },

    reattach() {
      classes.clear()
      renderPreviews()
      renderSelection()
    },
  }
}
