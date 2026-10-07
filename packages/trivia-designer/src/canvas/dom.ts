// Read-only queries against the user's document inside the canvas iframe. Nothing here writes
// to that DOM or attaches listeners to its elements.

import { isLibraryLocator } from './locator'

export const LOCATOR_ATTR = 'data-ast-node'
const SELECTOR = `[${LOCATOR_ATTR}]`

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function locatorOf(el: Element): string | null {
  return el.getAttribute(LOCATOR_ATTR)
}

/**
 * The usage-site element for `el`: its nearest annotated ancestor-or-self whose locator is
 * outside the component library. A library component that doesn't spread props onto an inner
 * element leaves that element with a definition-site locator (CLAUDE.md rule 5); selection
 * climbs past those to the component boundary the user wrote.
 */
export function usageSite(el: Element | null, uiDir: string): Element | null {
  let node = el?.closest(SELECTOR) ?? null
  while (node) {
    const loc = locatorOf(node)
    if (loc && !isLibraryLocator(loc, uiDir)) return node
    node = node.parentElement?.closest(SELECTOR) ?? null
  }
  return null
}

/** The nearest usage-site element strictly above `el`. */
export function usageParent(el: Element, uiDir: string): Element | null {
  return usageSite(el.parentElement, uiDir)
}

/** Topmost usage-site element at a point given in iframe viewport coordinates. */
export function hitTest(doc: Document, point: Point, uiDir: string): Element | null {
  const [top] = doc.elementsFromPoint(point.x, point.y)
  return usageSite(top ?? null, uiDir)
}

/** Every element rendered for `locator` (several when it sits inside `.map()`). */
export function elementsFor(doc: Document, locator: string): Element[] {
  return Array.from(doc.querySelectorAll(`[${LOCATOR_ATTR}="${CSS.escape(locator)}"]`))
}

/**
 * Usage-site elements whose nearest usage-site ancestor is `container`: the "annotated
 * children" a drop can be placed between, whatever library wrappers sit in between.
 */
export function annotatedChildren(container: Element, uiDir: string): Element[] {
  const out: Element[] = []
  for (const el of Array.from(container.querySelectorAll(SELECTOR))) {
    const loc = locatorOf(el)
    if (!loc || isLibraryLocator(loc, uiDir)) continue
    if (usageParent(el, uiDir) === container) out.push(el)
  }
  return out
}

/** A best guess at the JSX tag name from the DOM: shadcn's `data-slot` ("card-content" → CardContent), else the tag. */
export function guessName(el: Element): string {
  const slot = el.getAttribute('data-slot')
  if (slot && /^[a-z][a-z0-9-]*$/.test(slot)) {
    return slot.replace(/(^|-)([a-z0-9])/g, (_, _sep: string, c: string) => c.toUpperCase())
  }
  return el.tagName.toLowerCase()
}

/**
 * The tag the DOM shows for `elements` when it contradicts the engine's `name` for their
 * locator, else null. An intrinsic JSX element (`<h2>`, `<my-widget>`) renders as itself, so
 * every element stamped with its locator has its tag; a mismatch means the DOM was rendered
 * from other source than the engine just read. Components (`Button`, `motion.div`) may render
 * any tag and are never contradicted.
 */
export function contradictedBy(elements: readonly Element[], name: string): string | null {
  const [first] = elements
  if (!first || !/^[a-z][a-zA-Z0-9-]*$/.test(name)) return null
  const tag = name.toLowerCase()
  return elements.some((el) => el.localName.toLowerCase() === tag) ? null : first.localName
}

/** Euclidean distance from a point to a rect (0 inside); Tango's `distanceToRect`. */
export function distanceToRect(p: Point, r: DOMRectReadOnly): number {
  const dx = p.x < r.left ? r.left - p.x : p.x > r.right ? p.x - r.right : 0
  const dy = p.y < r.top ? r.top - p.y : p.y > r.bottom ? p.y - r.bottom : 0
  return Math.hypot(dx, dy)
}

export function unionRect(rects: readonly DOMRectReadOnly[]): Rect | null {
  const visible = rects.filter((r) => r.width > 0 || r.height > 0)
  if (visible.length === 0) return null
  const left = Math.min(...visible.map((r) => r.left))
  const top = Math.min(...visible.map((r) => r.top))
  const right = Math.max(...visible.map((r) => r.right))
  const bottom = Math.max(...visible.map((r) => r.bottom))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * The element a wheel gesture at `point` should scroll: the nearest ancestor of the element
 * under the cursor that can still move in the gesture's dominant direction, else the document's
 * scrolling element (scroll chaining, as the browser does natively).
 */
export function scrollTargetAt(doc: Document, point: Point, dx: number, dy: number): Element {
  const root = doc.scrollingElement ?? doc.documentElement
  const vertical = Math.abs(dy) >= Math.abs(dx)
  const delta = vertical ? dy : dx
  const win = doc.defaultView
  for (let el = doc.elementsFromPoint(point.x, point.y)[0] ?? null; el && win; el = el.parentElement) {
    if (el === root || el === doc.body || el === doc.documentElement) break
    const style = win.getComputedStyle(el)
    const overflow = vertical ? style.overflowY : style.overflowX
    if (!/(auto|scroll|overlay)/.test(overflow)) continue
    const pos = vertical ? el.scrollTop : el.scrollLeft
    const max = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth
    if (max <= 0) continue
    if ((delta > 0 && pos < max - 0.5) || (delta < 0 && pos > 0.5)) return el
  }
  return root
}
