// The canvas controller: everything imperative behind <Canvas>. It hit-tests the overlay's
// pointer events against the iframe document, turns gestures into ops on the action bus,
// measures what the overlay draws, and implements the CanvasApi other modules preview through.
//
// Coordinates: "client" is the designer's viewport, "frame" is the iframe's viewport (CSS px of
// the app, before zoom), "overlay" is relative to the overlay element. FrameSession.transform()
// maps frame → client.

import { toast } from 'sonner'

import { ApiError } from '@/bridge/client'
import type { ImportSpec } from '@/bridge/types'
import type { Template } from '@/registry/templates'
import { dispatch } from '@/state/actions'
import { type DesignerState, designer } from '@/state/store'

import type { CanvasApi } from './api'
import { type Point, type Rect, elementsFor, guessName, hitTest, locatorOf, scrollTargetAt, usageParent } from './dom'
import { type DragSubject, type DropPlan, computeDrop } from './dropzone'
import { FrameSession, type FrameTransform } from './frame-session'
import { isRootLocator, parseLocator } from './locator'
import { NodeInfo } from './node-info'
import { PREVIEW_ATTR, PREVIEW_STYLE_ID, Previews } from './previews'

/** dataTransfer type the palette puts a JSON Template under. */
export const TEMPLATE_MIME = 'application/x-trivia-template'
const DRAG_THRESHOLD_PX = 4
/** A page that renders nothing annotated this long after load is reported, not waited on. */
const LOCATOR_GRACE_MS = 1500

export interface Highlight {
  locator: string
  name: string
  /** One box per DOM element carrying the locator, in overlay coordinates. */
  boxes: Rect[]
  /** Size of the first element in the app's CSS pixels (unzoomed). */
  size: { width: number; height: number }
}

export type DropView =
  | { kind: 'line'; from: Point; to: Point; container: Rect | null }
  | { kind: 'inside'; rect: Rect }

/** The chip that follows the cursor during a drag: what moves, and where it would land. */
export interface CursorChip {
  at: Point
  kind: 'move' | 'insert'
  /** The dragged node's name, or the template's label. */
  subject: string
  /** "After div", or why the drop is refused; null over nothing droppable. */
  target: string | null
  refused: boolean
}

export type CanvasStatus = 'loading' | 'engine' | 'blocked' | 'no-locators' | 'build-error' | 'ready'

export interface CanvasView {
  status: CanvasStatus
  bounds: { width: number; height: number }
  hover: Highlight | null
  selection: Highlight | null
  /** The selection is being dragged to a new place. */
  moving: boolean
  drop: DropView | null
  cursor: CursorChip | null
}

export const EMPTY_VIEW: CanvasView = {
  status: 'loading',
  bounds: { width: 0, height: 0 },
  hover: null,
  selection: null,
  moving: false,
  drop: null,
  cursor: null,
}

interface Gesture {
  pointerId: number
  start: Point
  locator: string
  dragging: boolean
}

type DropState = { ok: true; plan: DropPlan } | { ok: false; reason: string } | null

export class CanvasController {
  private readonly session: FrameSession
  private readonly previews: Previews
  private readonly info: NodeInfo
  /** Last cursor position over the overlay (client coordinates). */
  private pointer: Point | null = null
  private gesture: Gesture | null = null
  private dropState: DropState = null
  /** Selection to scroll into view once it is rendered. */
  private reveal: string | null = null
  /** An edit returned and its HMR hasn't rendered yet. */
  private awaitingEdit = false
  /**
   * What the selection box shows while an edit renders: the op already selected its result
   * locator, but until HMR lands the DOM still carries the old locators, so drawing the new
   * one would outline whatever node sits at that position today.
   */
  private held: { selection: Highlight | null } | null = null
  private attachedAt = 0
  private view: CanvasView = EMPTY_VIEW

  readonly api: CanvasApi = {
    elements: (locator) => this.elementsOf(locator).filter(isHTMLElement),
    previewClassName: (locator, previous, next) => this.previews.className(locator, previous, next),
    previewStyle: (locator, style) => this.previews.style(locator, style),
    clearPreviews: () => this.previews.clear(),
  }

  private readonly overlay: HTMLElement
  private readonly onView: (view: CanvasView) => void

  constructor(iframe: HTMLIFrameElement, overlay: HTMLElement, onView: (view: CanvasView) => void) {
    this.overlay = overlay
    this.onView = onView
    this.session = new FrameSession(iframe, {
      attached: () => this.onAttached(),
      layout: () => this.measure(),
      settled: () => this.onSettled(),
    })
    this.session.isOwnMutation = (r) => this.isOwnMutation(r)
    this.previews = new Previews(
      () => this.session.doc,
      (locator) => this.elementsOf(locator),
      () => this.session.scheduleLayout(),
    )
    this.info = new NodeInfo(() => this.session.scheduleLayout())
  }

  /** Start observing; returns the cleanup. */
  mount(): () => void {
    const stop = this.session.start()
    const unsubscribe = designer.subscribe((s, prev) => this.onStore(s, prev))
    const o = this.overlay
    const listeners: Array<[string, (e: never) => void, AddEventListenerOptions?]> = [
      ['pointerdown', this.onPointerDown],
      ['pointermove', this.onPointerMove],
      ['pointerup', this.onPointerUp],
      ['pointercancel', this.onPointerCancel],
      ['lostpointercapture', this.onPointerCancel],
      ['pointerleave', this.onPointerLeave],
      ['wheel', this.onWheel, { passive: false }],
      ['dragenter', this.onDragOver],
      ['dragover', this.onDragOver],
      ['dragleave', this.onDragLeave],
      ['drop', this.onDrop],
      ['keydown', this.onKeyDown],
    ]
    for (const [type, fn, options] of listeners) o.addEventListener(type, fn as EventListener, options)
    // The designer's own layout can move the canvas without resizing the iframe.
    const relayout = () => this.session.scheduleLayout()
    window.addEventListener('resize', relayout)
    this.session.scheduleLayout()
    return () => {
      for (const [type, fn, options] of listeners) o.removeEventListener(type, fn as EventListener, options)
      window.removeEventListener('resize', relayout)
      unsubscribe()
      stop()
    }
  }

  // ---------------------------------------------------------------------------------------
  // Frame and store events

  private onAttached(): void {
    this.attachedAt = performance.now()
    this.previews.reset()
    this.info.clear()
    designer.getState().bumpRevision()
  }

  /** HMR re-rendered the app: locators may have shifted, previews are stale. */
  private onSettled(): void {
    this.awaitingEdit = false
    this.held = null
    this.info.clear()
    this.previews.clear()
    designer.getState().bumpRevision()
  }

  private onStore(s: DesignerState, prev: DesignerState): void {
    // An edit (or undo/redo) returned: its HMR is on the way.
    if (s.history !== prev.history) {
      this.awaitingEdit = true
      this.session.expectUpdate()
    }
    if (s.details && s.details !== prev.details) this.info.seed(s.details)
    if (s.selected !== prev.selected) {
      this.reveal = s.selected
      if (this.awaitingEdit && this.session.updating && !this.held) this.held = { selection: this.view.selection }
    }
    if (s.drag !== prev.drag && s.drag === null && !this.gesture?.dragging) this.dropState = null
    if (
      s.selected !== prev.selected ||
      s.hovered !== prev.hovered ||
      s.details !== prev.details ||
      s.zoom !== prev.zoom ||
      s.mode !== prev.mode ||
      s.drag !== prev.drag ||
      s.health !== prev.health ||
      s.componentsByName !== prev.componentsByName
    ) {
      this.session.scheduleLayout()
    }
  }

  private isOwnMutation(r: MutationRecord): boolean {
    if (r.type === 'attributes') {
      if (r.attributeName === PREVIEW_ATTR) return true
      return r.attributeName === 'class' && this.previews.owns(r.target)
    }
    if (r.type === 'childList') {
      const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)]
      return nodes.length > 0 && nodes.every((n) => n.nodeType === Node.ELEMENT_NODE && (n as Element).id === PREVIEW_STYLE_ID)
    }
    return false
  }

  // ---------------------------------------------------------------------------------------
  // Pointer: hover, select, move nodes

  private readonly onPointerDown = (e: PointerEvent): void => {
    const s = designer.getState()
    // The native mousedown focuses the overlay (tabIndex 0) for the keyboard shortcuts; focusing
    // it here instead would count as programmatic focus and paint the focus-visible ring.
    if (e.button !== 0 || s.mode !== 'design') return
    this.held = null
    const point = { x: e.clientX, y: e.clientY }
    const hit = this.hitAt(point)
    const locator = hit ? locatorOf(hit) : null
    s.select(locator)
    this.gesture = locator ? { pointerId: e.pointerId, start: point, locator, dragging: false } : null
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const point = { x: e.clientX, y: e.clientY }
    this.pointer = point
    const g = this.gesture
    if (g && g.pointerId === e.pointerId) {
      if (!g.dragging && Math.hypot(point.x - g.start.x, point.y - g.start.y) > DRAG_THRESHOLD_PX) {
        this.beginMove(g, e.pointerId)
      }
      if (g.dragging) {
        this.session.scheduleLayout() // measure() recomputes the drop target
        return
      }
    }
    this.rehover()
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    const g = this.gesture
    if (!g || g.pointerId !== e.pointerId) return
    this.gesture = null
    if (g.dragging) {
      this.updateDrop({ x: e.clientX, y: e.clientY })
      void this.finishMove(true)
    }
  }

  private readonly onPointerCancel = (e: PointerEvent): void => {
    const g = this.gesture
    if (!g || g.pointerId !== e.pointerId) return
    this.gesture = null
    if (g.dragging) void this.finishMove(false)
  }

  private readonly onPointerLeave = (): void => {
    if (this.gesture?.dragging) return
    this.pointer = null
    const s = designer.getState()
    if (s.hovered !== null) s.hover(null)
  }

  private beginMove(g: Gesture, pointerId: number): void {
    const s = designer.getState()
    const details = this.detailsFor(g.locator)
    const elements = this.elementsOf(g.locator)
    const name = details?.name ?? (elements[0] ? guessName(elements[0]) : 'node')
    // The engine refuses these (docs/api.md); say so up front instead of after the drop.
    const refusal = isRootLocator(g.locator)
      ? `it is the root of ${parseLocator(g.locator)?.scope ?? 'its component'}`
      : (details && !details.isDirect) || elements.length > 1
        ? 'it is rendered from a {…} expression'
        : null
    if (refusal) {
      this.gesture = null
      toast.error(`Can't move <${name}>: ${refusal}.`)
      return
    }
    g.dragging = true
    this.overlay.setPointerCapture(pointerId)
    s.hover(null)
    s.setDrag({ kind: 'node', locator: g.locator, name })
  }

  private async finishMove(commit: boolean): Promise<void> {
    const s = designer.getState()
    const drag = s.drag
    const drop = s.drop
    this.dropState = null
    if (this.gesture?.dragging) this.gesture = null
    s.setDrag(null)
    this.session.scheduleLayout()
    if (!commit || drag?.kind !== 'node' || !drop) return
    const name = await this.resolveName(drag.locator)
    if (name === null) return
    await dispatch(
      { op: 'move', source: drag.locator, expectedName: name, target: drop.target, placement: drop.placement },
      `Move ${name}`,
    )
  }

  private cancelMove(): void {
    const g = this.gesture
    if (!g?.dragging) return
    this.gesture = null
    if (this.overlay.hasPointerCapture(g.pointerId)) this.overlay.releasePointerCapture(g.pointerId)
    void this.finishMove(false)
  }

  // ---------------------------------------------------------------------------------------
  // Palette drops (HTML5 drag and drop)

  private readonly onDragOver = (e: DragEvent): void => {
    if (!this.acceptsTemplate(e)) return
    e.preventDefault()
    this.pointer = { x: e.clientX, y: e.clientY }
    this.updateDrop(this.pointer)
    if (e.dataTransfer) e.dataTransfer.dropEffect = this.dropState?.ok ? 'copy' : 'none'
    this.session.scheduleLayout()
  }

  private readonly onDragLeave = (e: DragEvent): void => {
    const to = e.relatedTarget
    if (to instanceof Node && this.overlay.contains(to)) return
    this.dropState = null
    this.pointer = null
    designer.getState().setDrop(null)
    this.session.scheduleLayout()
  }

  private readonly onDrop = (e: DragEvent): void => {
    if (!this.acceptsTemplate(e)) return
    e.preventDefault()
    this.updateDrop({ x: e.clientX, y: e.clientY })
    const s = designer.getState()
    const drop = s.drop
    const template = s.drag?.kind === 'palette' ? s.drag.template : parseTemplate(e.dataTransfer?.getData(TEMPLATE_MIME))
    this.dropState = null
    s.setDrag(null)
    this.session.scheduleLayout()
    if (!template) {
      toast.error('The dropped item is not a component template.')
      return
    }
    if (!drop) return
    void dispatch(
      { op: 'insert', target: drop.target, placement: drop.placement, snippet: template.snippet, imports: template.imports },
      `Insert ${template.label}`,
    )
  }

  private acceptsTemplate(e: DragEvent): boolean {
    if (this.gesture?.dragging) return false
    return designer.getState().drag?.kind === 'palette' || (e.dataTransfer?.types.includes(TEMPLATE_MIME) ?? false)
  }

  /** Recompute the drop target under `client` and publish it to the store. */
  private updateDrop(client: Point): void {
    const s = designer.getState()
    const doc = this.session.doc
    const uiDir = s.health?.uiDir
    const point = this.toFrame(client)
    const subject: DragSubject = s.drag?.kind === 'node' ? { kind: 'node', locator: s.drag.locator } : { kind: 'palette' }
    this.dropState =
      doc && uiDir && point
        ? computeDrop({ doc, uiDir, point, subject, components: s.componentsByName, info: (l) => this.detailsFor(l) })
        : null
    const t = this.session.transform()
    const plan = this.dropState?.ok ? this.dropState.plan : null
    if (!plan || !t) {
      if (s.drop !== null) s.setDrop(null)
      return
    }
    const rect = indicatorRect(plan, t)
    const same = s.drop && s.drop.target === plan.target && s.drop.placement === plan.placement && sameRect(s.drop.rect, rect)
    if (!same) s.setDrop({ target: plan.target, placement: plan.placement, rect })
  }

  // ---------------------------------------------------------------------------------------
  // Wheel and keyboard

  private readonly onWheel = (e: WheelEvent): void => {
    const s = designer.getState()
    const doc = this.session.doc
    const t = this.session.transform()
    const point = this.toFrame({ x: e.clientX, y: e.clientY })
    e.preventDefault()
    if (e.ctrlKey) {
      // Pinch on a trackpad (and ctrl+wheel) zooms the canvas.
      s.setZoom(s.zoom * Math.exp(-e.deltaY * 0.01))
      return
    }
    if (!doc || !t || !point) return
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? doc.documentElement.clientHeight : 1
    let dx = (e.deltaX * unit) / t.scale
    let dy = (e.deltaY * unit) / t.scale
    if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0]
    scrollTargetAt(doc, point, dx, dy).scrollBy({ left: dx, top: dy, behavior: 'instant' })
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isEditable(e.target)) return
    const s = designer.getState()
    // Handled keys stop here, so a global shortcut layer can't act on them a second time.
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.key === 'Escape') {
      if (this.gesture?.dragging) this.cancelMove()
      else if (s.selected !== null) s.select(null)
      else return
      handled()
      return
    }
    if (s.mode !== 'design' || e.metaKey || e.ctrlKey || e.altKey || !s.selected || this.gesture?.dragging) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      handled()
      void this.removeNode(s.selected)
    } else if (e.key === 'ArrowUp') {
      handled()
      void this.selectParent(s.selected)
    }
  }

  private async removeNode(locator: string): Promise<void> {
    const name = await this.resolveName(locator)
    if (name === null) return
    await dispatch({ op: 'remove', target: locator, expectedName: name }, `Delete ${name}`)
  }

  private async selectParent(locator: string): Promise<void> {
    let parent: string | null
    try {
      const details = this.detailsFor(locator) ?? (await this.info.load(locator))
      parent = details.parent
    } catch (error) {
      toast.error(errorMessage(error))
      return
    }
    const s = designer.getState()
    if (s.selected !== locator) return // the selection moved on while we asked
    // A component root's parent is wherever the app renders the component: climb the DOM.
    if (parent === null) {
      const el = this.elementsOf(locator)[0]
      const above = el && s.health ? usageParent(el, s.health.uiDir) : null
      parent = above ? locatorOf(above) : null
    }
    if (parent !== null) s.select(parent)
  }

  // ---------------------------------------------------------------------------------------
  // Measuring

  private measure(): void {
    const s = designer.getState()
    const doc = this.session.doc
    const o = this.overlay.getBoundingClientRect()
    const t = this.session.transform()
    const bounds = { width: o.width, height: o.height }
    const status = this.status(s, doc)
    if (!doc || !t) {
      this.publish({ ...EMPTY_VIEW, status, bounds })
      return
    }
    this.rehover()
    // During a gesture the content can scroll under a still cursor: keep the target current.
    if (this.pointer && (this.gesture?.dragging || s.drag?.kind === 'palette')) this.updateDrop(this.pointer)

    const toOverlay = (r: Rect): Rect => ({
      x: t.left - o.left + r.x * t.scale,
      y: t.top - o.top + r.y * t.scale,
      width: r.width * t.scale,
      height: r.height * t.scale,
    })
    const tracked: Element[] = []
    const highlight = (locator: string | null): Highlight | null => {
      if (!locator) return null
      const elements = elementsFor(doc, locator)
      const rects = elements.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 || r.height > 0)
      const first = elements[0]
      if (!first || !rects[0]) return null
      tracked.push(...elements)
      return {
        locator,
        name: this.nameFor(locator, first),
        boxes: rects.map(toOverlay),
        size: { width: Math.round(rects[0].width), height: Math.round(rects[0].height) },
      }
    }

    const selection = this.held ? this.held.selection : highlight(s.selected)
    const moving = s.drag?.kind === 'node'
    const hover = !moving && s.mode === 'design' && s.hovered !== s.selected ? highlight(s.hovered) : null
    this.session.track(tracked)
    if (selection && this.reveal === s.selected && !this.session.updating) {
      this.reveal = null
      revealInFrame(doc, elementsFor(doc, selection.locator)[0])
    }

    let drop: DropView | null = null
    const ds = this.dropState
    if (ds?.ok) {
      const { indicator, container } = ds.plan
      const point = (p: Point): Point => ({ x: t.left - o.left + p.x * t.scale, y: t.top - o.top + p.y * t.scale })
      drop =
        indicator.kind === 'line'
          ? { kind: 'line', from: point(indicator.from), to: point(indicator.to), container: container && toOverlay(container) }
          : { kind: 'inside', rect: toOverlay(indicator.rect) }
    }
    // The cursor chip says what the drop would do, so the indicator itself needs no label
    // over the app's content. Palette drags only get it when the shell published the template.
    let cursor: CursorChip | null = null
    const dragging = this.gesture?.dragging || s.drag?.kind === 'palette' || ds !== null
    if (dragging && this.pointer) {
      const at = { x: this.pointer.x - o.left, y: this.pointer.y - o.top }
      const target = ds?.ok ? `${PLACEMENT_VERB[ds.plan.placement]} ${ds.plan.name}` : (ds?.reason ?? null)
      cursor =
        s.drag?.kind === 'node'
          ? { at, kind: 'move', subject: s.drag.name, target, refused: ds?.ok === false }
          : { at, kind: 'insert', subject: s.drag?.kind === 'palette' ? s.drag.template.label : 'Component', target, refused: ds?.ok === false }
    }

    this.publish({ status, bounds, hover, selection, moving, drop, cursor })
  }

  private status(s: DesignerState, doc: Document | null): CanvasStatus {
    if (this.session.state === 'blocked') return 'blocked'
    if (!doc) return 'loading'
    if (!s.health) return 'engine'
    if (doc.querySelector('vite-error-overlay')) return 'build-error'
    if (!doc.querySelector('[data-ast-node]')) {
      return performance.now() - this.attachedAt < LOCATOR_GRACE_MS ? 'loading' : 'no-locators'
    }
    return 'ready'
  }

  private publish(view: CanvasView): void {
    if (JSON.stringify(view) === JSON.stringify(this.view)) return
    this.view = view
    this.onView(view)
  }

  /** Hover follows the cursor, and the content under it (scroll, HMR). */
  private rehover(): void {
    const s = designer.getState()
    if (s.mode !== 'design' || s.drag || this.gesture?.dragging) return
    const hit = this.pointer ? this.hitAt(this.pointer) : null
    const locator = hit ? locatorOf(hit) : null
    if (locator !== s.hovered) s.hover(locator)
  }

  // ---------------------------------------------------------------------------------------
  // Helpers

  private elementsOf(locator: string): Element[] {
    const doc = this.session.doc
    return doc ? elementsFor(doc, locator) : []
  }

  private toFrame(client: Point): Point | null {
    const t = this.session.transform()
    return t ? { x: (client.x - t.left) / t.scale, y: (client.y - t.top) / t.scale } : null
  }

  private hitAt(client: Point): Element | null {
    const doc = this.session.doc
    const uiDir = designer.getState().health?.uiDir
    const point = this.toFrame(client)
    return doc && uiDir && point ? hitTest(doc, point, uiDir) : null
  }

  private detailsFor(locator: string) {
    const { details } = designer.getState()
    return details?.locator === locator ? details : this.info.peek(locator)
  }

  private nameFor(locator: string, el: Element): string {
    return this.detailsFor(locator)?.name ?? guessName(el)
  }

  /** The JSX name for an op's `expectedName`; reports the failure when the engine can't say. */
  private async resolveName(locator: string): Promise<string | null> {
    const known = this.detailsFor(locator)
    if (known) return known.name
    try {
      return (await this.info.load(locator)).name
    } catch (error) {
      toast.error(errorMessage(error))
      return null
    }
  }
}

const PLACEMENT_VERB = { before: 'Before', after: 'After', firstChild: 'Inside', lastChild: 'Inside' } as const

/** Where the drop indicator sits, in client coordinates (store.drop.rect). */
function indicatorRect(plan: DropPlan, t: FrameTransform): Rect {
  const toClient = (p: Point): Point => ({ x: t.left + p.x * t.scale, y: t.top + p.y * t.scale })
  if (plan.indicator.kind === 'inside') {
    const r = plan.indicator.rect
    return { x: t.left + r.x * t.scale, y: t.top + r.y * t.scale, width: r.width * t.scale, height: r.height * t.scale }
  }
  const a = toClient(plan.indicator.from)
  const b = toClient(plan.indicator.to)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Scroll the app's document (not the designer) so `el` is in view, if it is entirely outside. */
function revealInFrame(doc: Document, el: Element | undefined): void {
  const view = doc.defaultView
  if (!el || !view) return
  const r = el.getBoundingClientRect()
  const height = view.innerHeight
  if (r.bottom >= 0 && r.top <= height) return
  const scroller = doc.scrollingElement ?? doc.documentElement
  scroller.scrollBy({ top: r.top - Math.max(16, (height - r.height) / 2), behavior: 'instant' })
}

/** Elements of the iframe's realm fail `instanceof HTMLElement` against the designer's. */
function isHTMLElement(el: Element): el is HTMLElement {
  const view = el.ownerDocument.defaultView as (Window & typeof globalThis) | null
  return view !== null && el instanceof view.HTMLElement
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

function parseTemplate(raw: string | undefined): Template | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const t = value as Record<string, unknown>
  const isImport = (i: unknown): i is ImportSpec =>
    typeof i === 'object' && i !== null && typeof (i as ImportSpec).name === 'string' && typeof (i as ImportSpec).source === 'string'
  if (
    typeof t.component !== 'string' ||
    typeof t.label !== 'string' ||
    typeof t.snippet !== 'string' ||
    !Array.isArray(t.imports) ||
    !t.imports.every(isImport)
  ) {
    return null
  }
  return { component: t.component, label: t.label, snippet: t.snippet, imports: t.imports }
}
