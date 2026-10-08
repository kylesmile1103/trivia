// Drop zones, ported from Tango (references/tango/packages/designer/src/dnd/use-dnd.ts ~194-357,
// src/helpers/dom.ts) onto locators: under the cursor find the nearest usage-site element; a
// container with annotated children places the drop before/after its nearest child (by rect
// distance, then midpoint along the container's main axis); an empty container takes it as
// last child; a leaf places it before/after itself. All geometry is in iframe viewport
// coordinates.

import type { ComponentSchema, NodeDetails, Placement } from '@/shared/engine/types'

import {
  type Point,
  type Rect,
  annotatedChildren,
  distanceToRect,
  elementsFor,
  guessName,
  hitTest,
  locatorOf,
  unionRect,
  usageParent,
} from './dom'
import { isRootLocator, isSameOrInside } from './locator'

export type DragSubject = { kind: 'palette' } | { kind: 'node'; locator: string }

export interface DropContext {
  doc: Document
  uiDir: string
  /** Cursor in iframe viewport coordinates. */
  point: Point
  subject: DragSubject
  components: Record<string, ComponentSchema>
  /** Cached engine details, or undefined while unknown (a lookup is then in flight). */
  info(locator: string): NodeDetails | undefined
}

export type Indicator = { kind: 'line'; from: Point; to: Point } | { kind: 'inside'; rect: Rect }

export interface DropPlan {
  target: string
  placement: Placement
  /** Display name of the target node. */
  name: string
  indicator: Indicator
  /** The element that receives the new child (context outline); null when it has no box. */
  container: Rect | null
}

export type DropResult = { ok: true; plan: DropPlan } | { ok: false; reason: string }

type Axis = 'x' | 'y'

/** Components and tags never treated as drop containers, even when their display would allow it. */
const LEAVES = new Set([
  'Button', 'Badge', 'Label', 'Input', 'Textarea', 'Switch', 'Checkbox', 'Separator',
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'img', 'input',
])

/** Elements that must not receive JSX children at all (React rejects children on void tags). */
const CHILDLESS = new Set([
  'Input', 'Textarea', 'Switch', 'Checkbox', 'Separator',
  'area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'source', 'textarea', 'track', 'wbr',
])

const CONTAINER_DISPLAY = /^(block|flex|grid|inline-flex|inline-grid|flow-root|list-item)$/

/** Where a drag at `ctx.point` would land; null when there is nothing to drop onto. */
export function computeDrop(ctx: DropContext): DropResult | null {
  const win = ctx.doc.defaultView
  if (!win) return null
  // A node never drops into itself: start from the nearest element outside its subtree.
  let hit = hitTest(ctx.doc, ctx.point, ctx.uiDir)
  while (hit && inSubject(ctx, locatorOf(hit) ?? '')) hit = usageParent(hit, ctx.uiDir)
  if (!hit) return null
  const locator = locatorOf(hit)
  if (!locator) return null

  const name = nameOf(ctx, hit, locator)
  const plan = isContainer(ctx, win, hit, name) ? intoContainer(ctx, win, hit, locator, name) : aroundLeaf(ctx, win, hit, locator, name)
  if (!plan) return null

  if (ctx.subject.kind === 'node') {
    const source = ctx.subject.locator
    // Into another file too: the engine brings the element's imports along, or says why not.
    if (isSameOrInside(plan.target, source)) return null
  }
  return { ok: true, plan }
}

function intoContainer(ctx: DropContext, win: Window, el: Element, locator: string, name: string): DropPlan {
  // Children that belong to this node in source (same file and component, deeper path): DOM
  // from another component (e.g. a page rendered inside <main>) is not a sibling slot here.
  const children = annotatedChildren(el, ctx.uiDir).filter((child) => {
    const loc = locatorOf(child) ?? ''
    return loc !== locator && isSameOrInside(loc, locator) && !inSubject(ctx, loc)
  })
  let nearest: Element | null = null
  let best = Infinity
  for (const child of children) {
    const d = distanceToRect(ctx.point, child.getBoundingClientRect())
    if (d < best) [nearest, best] = [child, d]
  }
  const childLoc = nearest ? locatorOf(nearest) : null
  // Nodes from `{…}` can't anchor before/after: append to the container instead.
  if (!nearest || !childLoc || !isDirect(ctx, childLoc)) return inside(ctx, el, locator, name)

  const r = nearest.getBoundingClientRect()
  const axis = mainAxis(win, el, nearest)
  const before = axis === 'x' ? ctx.point.x < r.left + r.width / 2 : ctx.point.y < r.top + r.height / 2
  return {
    target: childLoc,
    placement: before ? 'before' : 'after',
    name: nameOf(ctx, nearest, childLoc),
    indicator: edge(r, axis, before),
    container: boxOf(el),
  }
}

function aroundLeaf(ctx: DropContext, win: Window, el: Element, locator: string, name: string): DropPlan | null {
  // A component root has no siblings in source: offer its inside, when it can take children.
  if (isRootLocator(locator)) return canHaveChildren(ctx, name) ? inside(ctx, el, locator, name) : null

  if (!isDirect(ctx, locator)) {
    // Rendered from `{…}` (e.g. `.map()`): append to the element that holds the expression.
    const parentLoc = ctx.info(locator)?.parent ?? null
    const parentEl = (parentLoc ? elementsFor(ctx.doc, parentLoc)[0] : undefined) ?? usageParent(el, ctx.uiDir)
    const target = parentLoc ?? (parentEl ? locatorOf(parentEl) : null)
    if (!parentEl || !target || inSubject(ctx, target)) return null
    return inside(ctx, parentEl, target, nameOf(ctx, parentEl, target))
  }

  const r = el.getBoundingClientRect()
  const axis = el.parentElement ? mainAxis(win, el.parentElement, el) : 'y'
  const before = axis === 'x' ? ctx.point.x < r.left + r.width / 2 : ctx.point.y < r.top + r.height / 2
  const parent = usageParent(el, ctx.uiDir)
  return {
    target: locator,
    placement: before ? 'before' : 'after',
    name,
    indicator: edge(r, axis, before),
    container: parent ? boxOf(parent) : null,
  }
}

function inside(ctx: DropContext, el: Element, locator: string, name: string): DropPlan {
  const rect = unionRect(elementsFor(ctx.doc, locator).map((e) => e.getBoundingClientRect())) ?? boxOf(el)
  return { target: locator, placement: 'lastChild', name, indicator: { kind: 'inside', rect }, container: rect }
}

function inSubject(ctx: DropContext, locator: string): boolean {
  return ctx.subject.kind === 'node' && isSameOrInside(locator, ctx.subject.locator)
}

function nameOf(ctx: DropContext, el: Element, locator: string): string {
  return ctx.info(locator)?.name ?? guessName(el)
}

/** Unknown details count as direct unless several elements share the locator (a `.map()`). */
function isDirect(ctx: DropContext, locator: string): boolean {
  const details = ctx.info(locator)
  if (details) return details.isDirect
  return elementsFor(ctx.doc, locator).length <= 1
}

function canHaveChildren(ctx: DropContext, name: string): boolean {
  return !CHILDLESS.has(name) && ctx.components[name]?.acceptsChildren !== false
}

function isContainer(ctx: DropContext, win: Window, el: Element, name: string): boolean {
  if (LEAVES.has(name) || !canHaveChildren(ctx, name)) return false
  return CONTAINER_DISPLAY.test(win.getComputedStyle(el).display)
}

/** The axis siblings flow along inside `container`: row flex and multi-column grids → X, inline children → X, else Y. */
function mainAxis(win: Window, container: Element, child: Element): Axis {
  const style = win.getComputedStyle(container)
  if (style.display.endsWith('flex')) return style.flexDirection.startsWith('row') ? 'x' : 'y'
  if (style.display.endsWith('grid')) {
    const tracks = style.gridTemplateColumns.split(/\s+/).filter((t) => t !== '' && t !== 'none' && !t.startsWith('['))
    return tracks.length > 1 ? 'x' : 'y'
  }
  return win.getComputedStyle(child).display.startsWith('inline') ? 'x' : 'y'
}

function edge(r: DOMRectReadOnly, axis: Axis, before: boolean): Indicator {
  if (axis === 'y') {
    const y = before ? r.top : r.bottom
    return { kind: 'line', from: { x: r.left, y }, to: { x: r.right, y } }
  }
  const x = before ? r.left : r.right
  return { kind: 'line', from: { x, y: r.top }, to: { x, y: r.bottom } }
}

function boxOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}
