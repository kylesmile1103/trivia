// Live previews in the canvas iframe (two-phase editing, adopted from Onlook): transient
// className and CSS overrides shown during a gesture and dropped on commit or HMR. The only
// things written into the user's document: the `class` of previewed elements (restored), one
// `data-trivia-preview-id` attribute per previewed element, and one `<style id="trivia-preview">`.

import { twMerge } from 'tailwind-merge'

export const PREVIEW_STYLE_ID = 'trivia-preview'
export const PREVIEW_ATTR = 'data-trivia-preview-id'

interface ClassPreview {
  /** The element's class attribute before the first preview (null: it had none). */
  original: string | null
  /** What the preview wrote; restoring only happens while the element still shows it. */
  applied: string
}

interface StylePreview {
  id: string
  elements: Element[]
}

const tokens = (s: string) => s.split(/\s+/).filter(Boolean)

export class Previews {
  private readonly classes = new Map<string, Map<Element, ClassPreview>>()
  private readonly styles = new Map<string, StylePreview>()
  private nextId = 1

  private readonly doc: () => Document | null
  private readonly elements: (locator: string) => Element[]
  /** Previews move geometry; the canvas re-measures. */
  private readonly changed: () => void

  constructor(doc: () => Document | null, elements: (locator: string) => Element[], changed: () => void) {
    this.doc = doc
    this.elements = elements
    this.changed = changed
  }

  /**
   * Swap the user-authored tokens `previous` for `next` on every element of `locator`:
   * tokens dropped from `previous` are removed from the rendered class, then `next` is merged
   * over it with twMerge so its utilities win conflicts with the component's own classes.
   * `next === null` restores the original class.
   */
  className(locator: string, previous: string, next: string | null): void {
    if (next === null) {
      this.restoreClasses(locator)
      this.changed()
      return
    }
    let entries = this.classes.get(locator)
    if (!entries) this.classes.set(locator, (entries = new Map()))
    const removed = new Set(tokens(previous).filter((t) => !tokens(next).includes(t)))
    for (const el of this.elements(locator)) {
      // Start from the original, unless React re-rendered the element since the last preview.
      const prior = entries.get(el)
      const current = el.getAttribute('class')
      const original = prior && current === prior.applied ? prior.original : current
      const kept = tokens(original ?? '').filter((t) => !removed.has(t))
      const applied = twMerge(kept.join(' '), next)
      el.setAttribute('class', applied)
      entries.set(el, { original, applied })
    }
    this.changed()
  }

  /** Apply CSS declarations (kebab-case property → value) to every element of `locator`; null removes them. */
  style(locator: string, style: Record<string, string> | null): void {
    const doc = this.doc()
    const existing = this.styles.get(locator)
    if (style === null) {
      if (existing) this.removeStyle(locator, existing)
      this.changed()
      return
    }
    if (!doc) return
    const entry = existing ?? { id: String(this.nextId++), elements: [] }
    const current = this.elements(locator)
    for (const el of entry.elements) if (!current.includes(el)) el.removeAttribute(PREVIEW_ATTR)
    for (const el of current) el.setAttribute(PREVIEW_ATTR, entry.id)
    entry.elements = current
    this.styles.set(locator, entry)

    // CSSOM rather than text, so a value can never break out of its declaration.
    const sheet = this.sheet(doc)
    const selector = `[${PREVIEW_ATTR}="${entry.id}"]`
    deleteRules(sheet, selector)
    const rule = sheet.cssRules[sheet.insertRule(`${selector} {}`, sheet.cssRules.length)] as CSSStyleRule
    for (const [property, value] of Object.entries(style)) {
      rule.style.setProperty(property, value, 'important')
      if (rule.style.getPropertyValue(property) === '') {
        console.warn(`[trivia] preview ignored an invalid declaration: ${property}: ${value}`)
      }
    }
    this.changed()
  }

  clear(): void {
    for (const locator of [...this.classes.keys()]) this.restoreClasses(locator)
    for (const [locator, entry] of [...this.styles]) this.removeStyle(locator, entry)
    this.styleElement()?.remove()
    this.changed()
  }

  /** A new document was loaded: previous previews died with the old one. */
  reset(): void {
    this.classes.clear()
    this.styles.clear()
  }

  /** True when a mutation of `el`'s class is the preview's own write (the canvas ignores those). */
  owns(el: Node): boolean {
    for (const entries of this.classes.values()) {
      const entry = entries.get(el as Element)
      if (entry) return (el as Element).getAttribute('class') === entry.applied
    }
    return false
  }

  private restoreClasses(locator: string): void {
    const entries = this.classes.get(locator)
    if (!entries) return
    for (const [el, { original, applied }] of entries) {
      // React may have re-rendered the element with a new className since: leave that alone.
      if (!el.isConnected || el.getAttribute('class') !== applied) continue
      if (original === null) el.removeAttribute('class')
      else el.setAttribute('class', original)
    }
    this.classes.delete(locator)
  }

  private removeStyle(locator: string, entry: StylePreview): void {
    for (const el of entry.elements) el.removeAttribute(PREVIEW_ATTR)
    const el = this.styleElement()
    if (el?.sheet) deleteRules(el.sheet, `[${PREVIEW_ATTR}="${entry.id}"]`)
    this.styles.delete(locator)
    if (this.styles.size === 0) el?.remove()
  }

  private styleElement(): HTMLStyleElement | null {
    const el = this.doc()?.getElementById(PREVIEW_STYLE_ID)
    return el?.tagName === 'STYLE' ? (el as HTMLStyleElement) : null
  }

  private sheet(doc: Document): CSSStyleSheet {
    let el = this.styleElement()
    if (!el) {
      el = doc.createElement('style')
      el.id = PREVIEW_STYLE_ID
      doc.head.append(el)
    }
    if (!el.sheet) throw new Error('trivia-preview stylesheet is not attached to the document')
    return el.sheet
  }
}

function deleteRules(sheet: CSSStyleSheet, selector: string): void {
  for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
    const rule = sheet.cssRules[i]
    if (rule && 'selectorText' in rule && (rule as CSSStyleRule).selectorText === selector) sheet.deleteRule(i)
  }
}
