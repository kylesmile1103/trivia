// The canvas controller: everything imperative behind <Canvas>. It hit-tests the overlay's
// pointer events against the iframe document, turns gestures into ops on the action bus,
// measures what the overlay draws, and implements the CanvasApi other modules preview through.
//
// Coordinates: "client" is the designer's viewport, "frame" is the iframe's viewport (CSS px of
// the app, before zoom), "overlay" is relative to the overlay element. FrameSession.transform()
// maps frame → client.

import { toast } from 'sonner'

import type { CanvasApi, MovePlacement } from '@/shared/canvas'
import { ApiError } from '@/shared/engine/client'
import type { ImportSpec, NodeDetails, Op, Placement } from '@/shared/engine/types'
import { dispatch, dispatchBatch, isApplying, onIdle } from '@/shared/state/actions'
import { ZOOM_MIN } from '@/shared/state/zoom'
import { isRootLocator, parseLocator } from '@/shared/lib/locator'
import { type DesignerState, designer } from '@/shared/state/store'
import { TEMPLATE_MIME, type Template, templateOps } from '@/shared/template'

import { type Capture, captureDocument } from './capture'
import {
  type Point,
  type Rect,
  contradictedBy,
  elementsFor,
  guessName,
  hitTest,
  layerTree,
  locatorOf,
  scrollTargetAt,
  usageParent,
} from './dom'
import { type DragSubject, type DropPlan, computeDrop } from './dropzone'
import { FrameSession, type FrameTransform } from './frame-session'
import { NodeInfo } from './node-info'
import { PREVIEW_ATTR, PREVIEW_STYLE_ID, Previews } from './previews'

const DRAG_THRESHOLD_PX = 4
/** Tallest page a screenshot covers (px of the app). */
const MAX_CAPTURE_HEIGHT = 4000
/** Under the plugin's 15 s, so the agent hears why a capture stalled, not just that it did. */
const CAPTURE_TIMEOUT_MS = 10_000
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

/** The right-click menu: where it opened, on what, and why each action is unavailable (null: available). */
export interface ContextMenuView {
  /** Bumped per opening, so the menu anchors afresh at each click. */
  id: number
  /** Overlay coordinates of the click. */
  at: Point
  locator: string
  name: string
  moveUp: string | null
  moveDown: string | null
  remove: string | null
}

export type MenuAction = 'selectParent' | 'moveUp' | 'moveDown' | 'remove'

export type CanvasStatus = 'loading' | 'engine' | 'blocked' | 'no-locators' | 'build-error' | 'ready'

export interface CanvasView {
  status: CanvasStatus
  bounds: { width: number; height: number }
  hover: Highlight | null
  selection: Highlight | null
  /** The selection is being dragged to a new place. */
  moving: boolean
  /**
   * An edit hasn't rendered yet: a press waits to select until it has, and drags, Delete and
   * drops are refused meanwhile.
   */
  updating: boolean
  drop: DropView | null
  cursor: CursorChip | null
  menu: ContextMenuView | null
}

export const EMPTY_VIEW: CanvasView = {
  status: 'loading',
  bounds: { width: 0, height: 0 },
  hover: null,
  selection: null,
  moving: false,
  updating: false,
  drop: null,
  cursor: null,
  menu: null,
}

/** An open right-click menu (client coordinates), and the epoch whose DOM it was read from. */
interface Menu extends Omit<ContextMenuView, 'at'> {
  client: Point
  epoch: number
  /** Sibling locators the moves aim at. */
  prev: string | null
  next: string | null
}

interface Gesture {
  pointerId: number
  start: Point
  locator: string
  dragging: boolean
  /** `CanvasController.epoch` at the press: the DOM `locator` was read from. */
  epoch: number
}

/** One toast for every refusal, so repeated presses replace it instead of stacking. */
const REFUSED_TOAST = 'canvas-refused'
const UPDATING = 'Waiting for the app to update…'

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
  /**
   * A press made while the canvas was stale, waiting to select: where it landed in the app's
   * document (frame coordinates plus the document's scroll), so scrolling meanwhile doesn't
   * move it. The store's `pressPending` says whether anything has superseded it since.
   */
  private press: Point | null = null
  /** An edit returned and its HMR hasn't rendered yet. */
  private awaitingEdit = false
  /**
   * What the selection box shows while an edit renders: the op already selected its result
   * locator, but until HMR lands the DOM still carries the old locators, so drawing the new
   * one would outline whatever node sits at that position today.
   */
  private held: { selection: Highlight | null } | null = null
  /**
   * Bumped whenever the DOM's locators may stop describing the source: an edit landed, the
   * app re-rendered, or a new document attached. Names looked up for a locator read from the
   * DOM are trusted only while it is unchanged since that read.
   */
  private epoch = 0
  private attachedAt = 0
  private view: CanvasView = EMPTY_VIEW
  private menu: Menu | null = null
  /** Bumped per right-click; a menu still loading for an older one is dropped. */
  private menuRequest = 0

  readonly api: CanvasApi = {
    elements: (locator) => this.elementsOf(locator).filter(isHTMLElement),
    previewClassName: (locator, previous, next) => this.previews.className(locator, previous, next),
    previewStyle: (locator, style) => this.previews.style(locator, style),
    clearPreviews: () => this.previews.clear(),
    fitZoom: () => this.fitZoom(),
    capture: () => this.capture(),
    layers: () => {
      const doc = this.session.doc
      const uiDir = designer.getState().health?.uiDir
      return doc && uiDir ? layerTree(doc, uiDir, (locator, el) => this.nameFor(locator, el)) : []
    },
    version: () => this.epoch,
    moveRefusal: (locator) => this.moveRefusal(locator),
    move: (source, target, placement, version) => this.moveTo(source, target, placement, version),
    moveStep: (locator, direction, version) => this.moveStep(locator, direction, version),
  }

  private readonly iframe: HTMLIFrameElement
  private readonly overlay: HTMLElement
  private readonly onView: (view: CanvasView) => void

  constructor(iframe: HTMLIFrameElement, overlay: HTMLElement, onView: (view: CanvasView) => void) {
    this.iframe = iframe
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
    // An edit that answers without changing anything (refused, or a no-op) leaves no history
    // change behind: a press waiting on it selects now.
    const stopIdle = onIdle(() => {
      this.settlePress()
      this.session.scheduleLayout()
    })
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
      ['contextmenu', this.onContextMenu],
    ]
    for (const [type, fn, options] of listeners) o.addEventListener(type, fn as EventListener, options)
    // The designer's own layout can move the canvas without resizing the iframe.
    const relayout = () => this.session.scheduleLayout()
    window.addEventListener('resize', relayout)
    this.session.scheduleLayout()
    return () => {
      for (const [type, fn, options] of listeners) o.removeEventListener(type, fn as EventListener, options)
      window.removeEventListener('resize', relayout)
      if (this.press) designer.getState().setPressPending(false) // nothing will settle it now
      this.press = null
      stopIdle()
      unsubscribe()
      stop()
    }
  }

  /**
   * The DOM's locators can't be trusted right now: an edit is on its way to disk, or it (or a
   * change from elsewhere) hasn't rendered yet. Until HMR lands, the DOM still carries the old
   * source's locators, so a locator read from it names whatever sits at that position in the
   * new source, and an engine lookup would confirm that node (CLAUDE.md rule 4, docs/api.md).
   * A press waits it out and then selects (`press`); drags, Delete and drops are refused. The
   * overlay shows a busy cursor meanwhile.
   */
  private get stale(): boolean {
    return isApplying() || this.awaitingEdit || this.session.updating
  }

  // ---------------------------------------------------------------------------------------
  // Frame and store events

  /** A new document renders the source as it is now (first load or a full reload). */
  private onAttached(): void {
    this.attachedAt = performance.now()
    // An update the old document was waiting for went with it (FrameSession.detach drops it
    // without settling), and the new one has nothing to hold.
    this.awaitingEdit = false
    this.held = null
    this.epoch++
    this.closeMenu()
    this.previews.reset()
    this.info.clear()
    designer.getState().bumpRevision()
  }

  /** HMR re-rendered the app: locators may have shifted, previews are stale. */
  private onSettled(): void {
    this.awaitingEdit = false
    this.held = null
    this.epoch++
    this.closeMenu()
    this.info.clear()
    this.previews.clear()
    this.settlePress()
    designer.getState().bumpRevision()
  }

  private onStore(s: DesignerState, prev: DesignerState): void {
    // An edit (or undo/redo) returned: its HMR is on the way.
    if (s.history !== prev.history) {
      this.awaitingEdit = true
      this.epoch++
      this.closeMenu()
      this.session.expectUpdate(s.lastEdit)
      this.session.scheduleLayout()
    }
    if (s.details && s.details !== prev.details) this.info.seed(s.details)
    if (this.menu && (s.selected !== this.menu.locator || s.zoom !== prev.zoom || s.mode !== prev.mode || s.drag !== null)) {
      this.closeMenu()
    }
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
    const point = { x: e.clientX, y: e.clientY }
    // What is under the cursor is the old render: selecting or dragging it would act on
    // whatever node now holds its position in source. A drag can't start (the busy cursor
    // says to wait), but the press isn't lost: it selects once the app has rendered.
    if (this.stale) {
      this.deferPress(point)
      return
    }
    this.press = null
    this.held = null
    const hit = this.hitAt(point)
    const locator = hit ? locatorOf(hit) : null
    s.select(locator)
    this.gesture = locator ? { pointerId: e.pointerId, start: point, locator, dragging: false, epoch: this.epoch } : null
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const point = { x: e.clientX, y: e.clientY }
    this.pointer = point
    const g = this.gesture
    if (g && g.pointerId === e.pointerId) {
      if (!g.dragging && Math.hypot(point.x - g.start.x, point.y - g.start.y) > DRAG_THRESHOLD_PX) {
        // The app re-rendered since the press: its locator may name another node by now.
        if (this.stale || g.epoch !== this.epoch) this.gesture = null
        else this.beginMove(g, e.pointerId)
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
    if (g.dragging) this.updateDrop({ x: e.clientX, y: e.clientY }) // while the gesture still says which DOM it read
    this.gesture = null
    if (g.dragging) void this.finishMove(true, g.epoch)
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

  /** Remember a press made while stale (a later one replaces it); `settlePress` selects with it. */
  private deferPress(client: Point): void {
    const doc = this.session.doc
    const point = this.toFrame(client)
    const view = doc?.defaultView
    if (!point || !view) return
    this.press = { x: point.x + view.scrollX, y: point.y + view.scrollY }
    designer.getState().setPressPending(true)
  }

  /**
   * Once the canvas is no longer stale, a waiting press selects whatever the rendered app shows
   * at its spot: the hit-test runs again on the new DOM, whose locators describe the source.
   * It is dropped when anything selected since (`pressPending` cleared), when the canvas left
   * design mode, and when there is nothing to select on (a build error, no locators).
   */
  private settlePress(): void {
    const press = this.press
    if (!press || this.stale) return
    const s = designer.getState()
    const doc = this.session.doc
    const status = this.status(s, doc)
    if (status === 'loading') return // a reloaded document that hasn't rendered yet
    this.press = null
    if (!s.pressPending) return
    const view = doc?.defaultView
    const uiDir = s.health?.uiDir
    if (s.mode !== 'design' || status !== 'ready' || !doc || !view || !uiDir) {
      s.setPressPending(false)
      return
    }
    const hit = hitTest(doc, { x: press.x - view.scrollX, y: press.y - view.scrollY }, uiDir)
    s.select(hit ? locatorOf(hit) : null)
  }

  private beginMove(g: Gesture, pointerId: number): void {
    const s = designer.getState()
    const elements = this.elementsOf(g.locator)
    const name = this.detailsFor(g.locator)?.name ?? (elements[0] ? guessName(elements[0]) : 'node')
    const refusal = this.moveRefusal(g.locator)
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

  /** End a node drag; `since` is the epoch of the press that read its locator. */
  private async finishMove(commit: boolean, since = this.epoch): Promise<void> {
    const s = designer.getState()
    const drag = s.drag
    const drop = s.drop
    this.dropState = null
    if (this.gesture?.dragging) this.gesture = null
    s.setDrag(null)
    this.session.scheduleLayout()
    if (!commit || drag?.kind !== 'node' || !drop) return
    const names = await this.expectedNames([drag.locator, drop.target], since, 'Nothing was moved')
    if (names === null) return
    const [name, targetName] = names
    await dispatch(
      {
        op: 'move',
        source: drag.locator,
        expectedName: name,
        target: drop.target,
        expectedTargetName: targetName,
        placement: drop.placement,
      },
      `Move ${name}`,
    )
  }

  /** Why `locator` can't move. The engine refuses these (docs/api.md): say so before the drop. */
  private moveRefusal(locator: string): string | null {
    if (isRootLocator(locator)) return `it is the root of ${parseLocator(locator)?.scope ?? 'its component'}`
    const details = this.detailsFor(locator)
    if ((details && !details.isDirect) || this.elementsOf(locator).length > 1) return 'it is rendered from a {…} expression'
    return null
  }

  /**
   * Move `source` before/after `target`, or inside it as its first child (`moveNode` at 0), for
   * a move made outside the canvas (the layers panel). `since` is the epoch its locators were
   * read at: expectedNames refuses them once the canvas has changed.
   */
  private async moveTo(source: string, target: string, placement: MovePlacement, since: number, suffix = ''): Promise<void> {
    const refusal = this.moveRefusal(source)
    if (refusal) {
      toast.error(`Nothing was moved: ${refusal}.`, { id: REFUSED_TOAST })
      return
    }
    const names = await this.expectedNames([source, target], since, 'Nothing was moved')
    if (names === null) return
    const [name, targetName] = names
    await dispatch(
      placement === 'inside'
        ? { op: 'moveNode', source, expectedName: name, parent: target, expectedParentName: targetName, index: 0 }
        : { op: 'move', source, expectedName: name, target, expectedTargetName: targetName, placement },
      `Move ${name}${suffix}`,
    )
  }

  /** Move `locator` past its previous or next sibling, under the right-click menu's rules. */
  private async moveStep(locator: string, direction: 'up' | 'down', since: number): Promise<void> {
    let menu: Awaited<ReturnType<CanvasController['menuFor']>>
    try {
      menu = await this.menuFor(locator)
    } catch (error) {
      toast.error(`Nothing was moved: ${errorMessage(error)}`, { id: REFUSED_TOAST })
      return
    }
    const why = direction === 'up' ? menu.moveUp : menu.moveDown
    const target = direction === 'up' ? menu.prev : menu.next
    if (why !== null || target === null) {
      toast.info(`Can't move <${menu.name}> ${direction}: ${why ?? 'it has no sibling there'}.`, { id: REFUSED_TOAST })
      return
    }
    await this.moveTo(locator, target, direction === 'up' ? 'before' : 'after', since, ` ${direction}`)
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
    if (!drop) return // refused (the chip said why) or over nothing droppable
    void this.insertTemplate(template, drop.target, drop.placement, this.epoch)
  }

  private async insertTemplate(template: Template, target: string, placement: Placement, since: number): Promise<void> {
    const names = await this.expectedNames([target], since, `${template.label} was not inserted`)
    const [expectedName] = names ?? []
    if (expectedName === undefined) return
    // expectedNames looked the target up: its children say where a last child lands (a bind's target).
    const childCount = this.detailsFor(target)?.children.length ?? 0
    const ops = templateOps(template, { target, expectedName, placement, childCount })
    const [only] = ops
    await (ops.length === 1 && only ? dispatch(only, `Insert ${template.label}`) : dispatchBatch(ops, `Insert ${template.label}`))
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
    const refusal = this.dropRefusal()
    this.dropState = !(doc && uiDir && point)
      ? null
      : refusal
        ? { ok: false, reason: refusal }
        : computeDrop({ doc, uiDir, point, subject, components: s.componentsByName, info: (l) => this.detailsFor(l) })
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

  /** Why nothing may be dropped right now (shown on the cursor chip), or null. */
  private dropRefusal(): string | null {
    if (this.stale) return UPDATING
    const g = this.gesture
    if (g?.dragging && g.epoch !== this.epoch) return 'The app changed during the drag'
    return null
  }

  // ---------------------------------------------------------------------------------------
  // Wheel and keyboard

  private readonly onWheel = (e: WheelEvent): void => {
    this.closeMenu() // the content scrolls out from under it
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

  // ---------------------------------------------------------------------------------------
  // Right-click menu

  /**
   * In design mode a right-click selects what is under the cursor, like a press, and opens the
   * menu there; the browser's own menu never shows over the canvas. Nothing opens over empty
   * canvas, during a drag, or while an edit renders (the DOM's locators can't be trusted:
   * `stale`). Interact mode leaves the right-click to the app.
   */
  private readonly onContextMenu = (e: MouseEvent): void => {
    const s = designer.getState()
    if (s.mode !== 'design') return
    e.preventDefault()
    this.closeMenu()
    if (this.gesture?.dragging || this.stale) return
    const client = { x: e.clientX, y: e.clientY }
    const hit = this.hitAt(client)
    const locator = hit ? locatorOf(hit) : null
    if (locator === null) return
    s.select(locator)
    void this.openMenu(client, locator, this.epoch, ++this.menuRequest)
  }

  private async openMenu(client: Point, locator: string, since: number, request: number): Promise<void> {
    let menu: Omit<Menu, 'id' | 'client' | 'epoch'>
    try {
      menu = await this.menuFor(locator)
    } catch (error) {
      toast.error(`No menu for this element: ${errorMessage(error)}`, { id: REFUSED_TOAST })
      return
    }
    // Something happened meanwhile: another right-click, a click, a re-render.
    if (request !== this.menuRequest || since !== this.epoch || this.stale || designer.getState().selected !== locator) return
    this.menu = { ...menu, id: request, client, epoch: since }
    this.session.scheduleLayout()
  }

  /** What each menu action can do for `locator`, from the engine's details (DOM: `.map` copies). */
  private async menuFor(locator: string): Promise<Omit<Menu, 'id' | 'client' | 'epoch'>> {
    const load = (l: string) => this.detailsFor(l) ?? this.info.load(l)
    const details = await load(locator)
    const base = { locator, name: details.name, prev: null, next: null }
    if (isRootLocator(locator) || details.parent === null) {
      const why = `it is the root of ${parseLocator(locator)?.scope ?? 'its component'}`
      return { ...base, moveUp: why, moveDown: why, remove: why }
    }
    if (!details.isDirect || this.elementsOf(locator).length > 1) {
      const why = 'it is rendered from a {…} expression'
      return { ...base, moveUp: why, moveDown: why, remove: why }
    }
    const siblings = (await load(details.parent)).children
    const i = siblings.indexOf(locator)
    const neighbour = async (at: string | undefined, end: string, side: string) => {
      if (at === undefined) return { locator: null, why: end }
      const d = await load(at)
      return { locator: at, why: d.isDirect ? null : `the element ${side} it is rendered from a {…} expression` }
    }
    const [up, down] = await Promise.all([
      neighbour(i > 0 ? siblings[i - 1] : undefined, 'it is already first', 'before'),
      neighbour(siblings[i + 1], 'it is already last', 'after'),
    ])
    return { ...base, prev: up.locator, next: down.locator, moveUp: up.why, moveDown: down.why, remove: null }
  }

  /** Close the right-click menu (the menu itself calls this on Escape and outside clicks). */
  closeMenu(): void {
    this.menuRequest++
    if (this.menu === null) return
    this.menu = null
    this.session.scheduleLayout()
  }

  /** Run a menu action on the element the menu opened on, then close it. */
  async runMenuAction(action: MenuAction): Promise<void> {
    const menu = this.menu
    this.closeMenu()
    if (menu === null) return
    if (action === 'selectParent') return this.selectParent(menu.locator)
    if (menu[action] !== null) return
    if (action === 'remove') return this.removeNode(menu.locator, menu.epoch)
    const up = action === 'moveUp'
    const target = up ? menu.prev : menu.next
    if (target === null) return
    await this.moveTo(menu.locator, target, up ? 'before' : 'after', menu.epoch, up ? ' up' : ' down')
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isEditable(e.target)) return
    this.settlePress() // a key acts on what the user clicked last, if the app has rendered since
    const s = designer.getState()
    // Handled keys stop here, so a global shortcut layer can't act on them a second time.
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.key === 'Escape') {
      if (this.gesture?.dragging) this.cancelMove()
      else if (s.selected !== null || s.pressPending) s.select(null) // also drops a waiting press
      else return
      handled()
      return
    }
    if (s.mode !== 'design' || e.metaKey || e.ctrlKey || e.altKey || !s.selected || this.gesture?.dragging) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      handled()
      void this.removeNode(s.selected, this.epoch)
    } else if (e.key === 'ArrowUp') {
      handled()
      void this.selectParent(s.selected)
    }
  }

  private async removeNode(locator: string, since: number): Promise<void> {
    const names = await this.expectedNames([locator], since, 'Nothing was deleted')
    if (names === null) return
    await dispatch({ op: 'remove', target: locator, expectedName: names[0] }, `Delete ${names[0]}`)
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
    this.settlePress() // before reading the store: the box then shows what it selected
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

    const m = this.menu
    const menu: ContextMenuView | null = m && {
      id: m.id,
      at: { x: m.client.x - o.left, y: m.client.y - o.top },
      locator: m.locator,
      name: m.name,
      moveUp: m.moveUp,
      moveDown: m.moveDown,
      remove: m.remove,
    }
    this.publish({ status, bounds, hover, selection, moving, updating: this.stale, drop, cursor, menu })
  }

  /**
   * The largest zoom, at most 100%, at which the app's whole page fits the canvas without
   * scrolling (null without a document). Zoom is browser zoom: the app lays out at the canvas
   * size divided by the zoom, so a smaller zoom also makes it wider (and often shorter). Each
   * candidate is measured by laying the app out at that size, all within this task, so nothing
   * is painted until the iframe has its size back.
   */
  private fitZoom(): number | null {
    const doc = this.session.doc
    if (!doc) return null
    const area = this.overlay.getBoundingClientRect()
    const style = this.iframe.style
    const saved = { width: style.width, height: style.height }
    const fits = (zoom: number) => {
      style.width = `${area.width / zoom}px`
      style.height = `${area.height / zoom}px`
      return doc.documentElement.scrollHeight * zoom <= area.height + 0.5
    }
    try {
      if (fits(1)) return 1
      if (!fits(ZOOM_MIN)) return ZOOM_MIN
      let lo = ZOOM_MIN
      let hi = 1
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2
        if (fits(mid)) lo = mid
        else hi = mid
      }
      return Math.floor(lo * 100) / 100
    } finally {
      style.width = saved.width
      style.height = saved.height
    }
  }

  /**
   * The app's page as a PNG, for agents (trivia_screenshot): its document rendered at its own
   * width, up to 4000 px of its height, without the designer's overlay.
   */
  private async capture(): Promise<Capture | null> {
    const doc = this.session.doc
    if (!doc?.defaultView) return null
    return captureDocument(doc, { maxHeight: MAX_CAPTURE_HEIGHT, timeoutMs: CAPTURE_TIMEOUT_MS })
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

  /**
   * The engine's names for locators the user picked on the canvas, for an op's expected names.
   * They must describe the source the DOM was rendered from: a lookup made after the source
   * changed names whatever sits at the locator now, and the engine's 409 could never fire.
   * So this refuses (null, reported as `refused: …`) when the canvas is updating or changed
   * since `since`, or when the DOM itself contradicts what the engine says is there; it
   * reports a failed lookup the same way.
   */
  private async expectedNames(locators: readonly string[], since: number, refused: string): Promise<string[] | null> {
    const fresh = () => !this.stale && this.epoch === since
    if (!fresh()) {
      toast.info(`${refused}: the canvas is still updating`, { id: REFUSED_TOAST, description: 'Try again once the app has re-rendered.' })
      return null
    }
    let details: NodeDetails[]
    try {
      details = await Promise.all(locators.map((l) => this.detailsFor(l) ?? this.info.load(l)))
    } catch (error) {
      toast.error(`${refused}: ${errorMessage(error)}`, { id: REFUSED_TOAST })
      return null
    }
    if (!fresh()) {
      toast.info(`${refused}: the app changed meanwhile`, { id: REFUSED_TOAST, description: 'Try again on what it shows now.' })
      return null
    }
    for (const d of details) {
      const shown = contradictedBy(this.elementsOf(d.locator), d.name)
      if (shown !== null) {
        toast.error(`${refused}: the canvas is out of date`, {
          id: REFUSED_TOAST,
          description: `It shows <${shown}> where ${d.file} now has <${d.name}>. Try again once the app has re-rendered.`,
        })
        return null
      }
    }
    return details.map((d) => d.name)
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
  const template: Template = { component: t.component, label: t.label, snippet: t.snippet, imports: t.imports }
  // A Data panel template: its extra ops (the engine validates them like any other) and binding.
  const isOp = (op: unknown) => typeof op === 'object' && op !== null && typeof (op as { op?: unknown }).op === 'string'
  if (Array.isArray(t.before) && t.before.every(isOp)) template.before = t.before as Op[]
  if (typeof t.bind === 'object' && t.bind !== null) template.bind = t.bind as Template['bind'] & object
  return template
}
