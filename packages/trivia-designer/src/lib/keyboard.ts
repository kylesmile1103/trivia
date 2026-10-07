// Keyboard helpers shared by the global shortcuts and the UI that advertises them.
//
// Shortcut events also arrive from the canvas iframe's window (same origin), whose elements
// belong to another realm: `instanceof HTMLInputElement` is false for them, so every check
// here goes by tag name and properties instead.

import { isMac } from '@/lib/env'

/** Input types that don't take text, so editing shortcuts (⌘Z) are free to act on them. */
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit'])

/** True when `target` is somewhere the user types, where ⌘Z must stay the native text undo. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as Partial<Element>).tagName !== 'string') return false
  const el = target as HTMLElement
  if (el.isContentEditable) return true
  switch (el.tagName) {
    case 'TEXTAREA':
    case 'SELECT':
      return true
    case 'INPUT':
      return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type)
    default:
      return el.getAttribute('role') === 'textbox'
  }
}

/** The platform's primary modifier: ⌘ on Apple platforms, Ctrl elsewhere. */
export function hasPrimaryModifier(event: KeyboardEvent): boolean {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/**
 * Display form of a shortcut written as `mod+shift+z`: `⇧⌘Z` on Apple platforms,
 * `Ctrl+Shift+Z` elsewhere. Parts: mod, shift, alt, and one key.
 */
export function formatShortcut(shortcut: string): string {
  const parts = shortcut.split('+')
  const key = parts.pop() ?? ''
  const label = KEY_LABELS[key] ?? key.toUpperCase()
  if (isMac) {
    const symbols = { alt: '⌥', shift: '⇧', mod: '⌘' } as const
    // Apple order: ⌥ ⇧ ⌘, then the key.
    const order = ['alt', 'shift', 'mod'] as const
    return order.filter((m) => parts.includes(m)).map((m) => symbols[m]).join('') + label
  }
  const names = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt' } as const
  const order = ['mod', 'alt', 'shift'] as const
  return [...order.filter((m) => parts.includes(m)).map((m) => names[m]), label].join('+')
}

const KEY_LABELS: Record<string, string> = { '=': '+', '-': '−', '/': '/', '0': '0', '1': '1' }

/**
 * Keep listeners on the window of every same-origin iframe in the designer document,
 * including frames added later and frames that navigate or reload (each load brings a new
 * inner window, which drops listeners attached to the previous one).
 *
 * `attach` must add listeners with stable function identities, so attaching twice to one
 * window is a no-op (the DOM dedupes identical listeners); it returns the matching detach.
 */
export function watchFrameWindows(attach: (win: Window) => () => void): () => void {
  const detachers = new Map<Window, () => void>()
  const bind = (frame: HTMLIFrameElement) => {
    const win = sameOriginWindow(frame)
    if (win === null) return
    detachers.get(win)?.()
    detachers.set(win, attach(win))
  }
  // `load` doesn't bubble, but it does pass the capture phase of the parent document.
  const onLoad = (event: Event) => {
    if (event.target instanceof HTMLIFrameElement) bind(event.target)
  }
  document.addEventListener('load', onLoad, true)
  document.querySelectorAll('iframe').forEach(bind)
  return () => {
    document.removeEventListener('load', onLoad, true)
    for (const detach of detachers.values()) detach()
    detachers.clear()
  }
}

function sameOriginWindow(frame: HTMLIFrameElement): Window | null {
  const win = frame.contentWindow
  if (win === null) return null
  try {
    // Throws for cross-origin frames, which aren't ours to listen to.
    void win.document
    return win
  } catch {
    return null
  }
}
