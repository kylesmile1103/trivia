// The canvas's binding to the user's document in the iframe: observes it (never injects
// listeners into its React elements) and reports two things to the canvas:
//
// - `layout`: geometry may have changed (scroll in any container, resize, layout shifts, DOM
//   mutation, previews). Coalesced to one call per animation frame.
// - `settled`: the app finished re-rendering after a source change (HMR). A change is expected
//   when Vite re-imports a module (`?t=<timestamp>`, visible in the iframe's resource timeline)
//   or when the designer's own edit returns. It has settled once the rendered DOM (outside
//   <head>) has changed and gone quiet. An app that animates or ticks never goes quiet, so the
//   wait is bounded: BUSY_MS after the update's render could begin (for the designer's own edit,
//   when its hot update arrived; otherwise the trigger), and MAX_WAIT_MS after the trigger in
//   any case (a no-op edit, or a hot update slower than that).

import { locatorFile } from '@/shared/lib/locator'

/** Mutations must pause this long before an update counts as rendered. */
const QUIET_MS = 120
/** Resource timing is delivered late: mutations this long before such a trigger still count. */
const EARLY_MS = 300
/** Settle this long after the update's render could begin at the latest, quiet or not. */
const BUSY_MS = 700
/** Settle this long after the trigger at the latest, whatever happened. */
const MAX_WAIT_MS = 1500
/** How long hot updates are remembered, to recognise an edit's own. */
const HOT_MEMORY_MS = 10_000
/** Re-measure every frame this long after a CSS transition/animation starts (boxes follow it). */
const ANIMATION_FOLLOW_MS = 1000

/** An edit whose answer just arrived: the files it wrote, and when it was sent (designer clock). */
export interface SentEdit {
  files: readonly string[]
  sentAt: number
}

/** A module Vite re-imported: its URL path, and when it was requested and arrived (designer clock). */
interface HotModule {
  path: string
  requestedAt: number
  arrivedAt: number
}

export type FrameState = 'loading' | 'attached' | 'blocked'

export interface FrameListener {
  /** A new document is attached: the first load or a full reload. */
  attached(): void
  layout(): void
  settled(): void
}

/** Maps iframe viewport coordinates to designer viewport (client) coordinates. */
export interface FrameTransform {
  scale: number
  left: number
  top: number
}

type FrameWindow = Window & typeof globalThis

export class FrameSession {
  doc: Document | null = null
  state: FrameState = 'loading'
  /** Set by the canvas: mutations the canvas made itself (previews) don't count as renders. */
  isOwnMutation: (record: MutationRecord) => boolean = () => false

  private teardown: Array<() => void> = []
  private resizeObserver: ResizeObserver | null = null
  private tracked: Element[] = []
  private raf = 0
  private pending = false
  private triggeredAt = 0
  /** Mutations from this time on count as the expected update's render. */
  private renderedAfter = 0
  private lastMutationAt = -Infinity
  private settleTimer = 0
  private animatingUntil = 0
  /** No settle before this (designer clock): a module that just arrived is about to render. */
  private floorAt = 0
  /** The designer's edit being waited for, if any; its hot update may be reported after its answer. */
  private edit: SentEdit | null = null
  /** Recent hot updates, oldest first. */
  private hot: HotModule[] = []
  /** Most recent mutation of stamped nodes in each source file in this document. */
  private fileRenders = new Map<string, number>()

  private readonly iframe: HTMLIFrameElement
  private readonly listener: FrameListener
  private readonly usesResourceTiming: () => boolean

  constructor(iframe: HTMLIFrameElement, listener: FrameListener, usesResourceTiming: () => boolean = () => true) {
    this.iframe = iframe
    this.listener = listener
    this.usesResourceTiming = usesResourceTiming
  }

  /** Attach now if the document already loaded, and on every later load. Returns the stop function. */
  start(): () => void {
    const onLoad = () => this.attach()
    this.iframe.addEventListener('load', onLoad)
    const win = this.iframe.contentWindow
    if (win && this.iframe.contentDocument?.readyState === 'complete' && win.location.href !== 'about:blank') this.attach()
    return () => {
      this.iframe.removeEventListener('load', onLoad)
      this.detach()
    }
  }

  /** True between an expected update and its settle. */
  get updating(): boolean {
    return this.pending
  }

  /**
   * A source change is on its way: an edit just answered. With the action bus's `edit` (the
   * files it wrote, when it was sent), its render is what the DOM does after the edit's own hot
   * update arrived (a re-import of every file it wrote, requested after the edit was sent),
   * even when that came before the answer; until it arrives the DOM can't show the edit,
   * however much it changes. Without one (a history read, a write made elsewhere), only
   * mutations after now count, so an app that happened to change a moment earlier doesn't end
   * the wait.
   */
  expectUpdate(edit: SentEdit | null = null): void {
    const now = performance.now()
    this.edit = edit && edit.files.length > 0 ? edit : null
    this.triggeredAt = now
    this.renderedAfter = now
    this.pending = true
    this.armSettle(0)
  }

  scheduleLayout(): void {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.listener.layout()
      // End events are unreliable (removed elements, infinite animations): follow for a while.
      if (performance.now() < this.animatingUntil) this.scheduleLayout()
    })
  }

  /** Watch these elements' boxes (the drawn selection/hover) for size changes. */
  track(elements: Element[]): void {
    const ro = this.resizeObserver
    if (!ro) return
    if (elements.length === this.tracked.length && elements.every((el, i) => el === this.tracked[i])) return
    for (const el of this.tracked) if (!elements.includes(el)) ro.unobserve(el)
    for (const el of elements) if (!this.tracked.includes(el)) ro.observe(el)
    this.tracked = elements
  }

  transform(): FrameTransform | null {
    const width = this.iframe.offsetWidth
    if (width === 0) return null
    const r = this.iframe.getBoundingClientRect()
    const scale = r.width / width
    return { scale, left: r.left + this.iframe.clientLeft * scale, top: r.top + this.iframe.clientTop * scale }
  }

  private attach(): void {
    this.detach()
    const doc = this.iframe.contentDocument
    const win = this.iframe.contentWindow as FrameWindow | null
    if (!doc || !win) {
      // Cross-origin: the designer must be served on the app's origin (its proxy).
      this.state = 'blocked'
      this.listener.attached()
      return
    }
    this.doc = doc
    this.state = 'attached'

    const listen = (target: EventTarget, type: string, fn: () => void, options: AddEventListenerOptions) => {
      target.addEventListener(type, fn, options)
      this.teardown.push(() => target.removeEventListener(type, fn, options))
    }
    const layout = () => this.scheduleLayout()
    // Scroll doesn't bubble: capturing on the document also sees nested scroll containers.
    listen(doc, 'scroll', layout, { capture: true, passive: true })
    const animating = () => {
      this.animatingUntil = performance.now() + ANIMATION_FOLLOW_MS
      this.scheduleLayout()
    }
    for (const type of ['transitionrun', 'animationstart']) listen(doc, type, animating, { capture: true, passive: true })
    for (const type of ['transitionend', 'transitioncancel', 'animationend', 'animationcancel']) {
      listen(doc, type, layout, { capture: true, passive: true })
    }
    listen(win, 'resize', layout, { passive: true })
    listen(win, 'pagehide', () => this.detach(), { once: true })

    // Observers come from the iframe's realm so they observe its nodes natively.
    const mutations = new win.MutationObserver((records) => this.onMutations(records))
    mutations.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    const resizes = new win.ResizeObserver(layout)
    resizes.observe(doc.documentElement)
    if (doc.body) resizes.observe(doc.body)
    this.resizeObserver = resizes
    this.tracked = []
    // Resource timing is in the frame's clock; the canvas (and the action bus) use the designer's.
    const offset = win.performance.timeOrigin - performance.timeOrigin
    const hot = new win.PerformanceObserver((list) => {
      if (!this.usesResourceTiming()) return
      const modules: HotModule[] = []
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        const path = hotUpdatePath(entry.name, win.location.origin)
        if (path !== null) {
          const arrived = entry.responseEnd || entry.startTime + entry.duration
          modules.push({ path, requestedAt: entry.startTime + offset, arrivedAt: arrived + offset })
        }
      }
      if (modules.length > 0) this.onHotUpdate(modules)
    })
    hot.observe({ type: 'resource' })
    this.teardown.push(() => {
      mutations.disconnect()
      resizes.disconnect()
      hot.disconnect()
      this.resizeObserver = null
    })

    this.listener.attached()
    this.scheduleLayout()
  }

  private detach(): void {
    for (const fn of this.teardown.splice(0)) fn()
    if (this.raf) cancelAnimationFrame(this.raf)
    clearTimeout(this.settleTimer)
    this.raf = 0
    this.pending = false
    this.edit = null
    this.hot = []
    this.fileRenders.clear()
    this.doc = null
    this.tracked = []
    if (this.state === 'attached') this.state = 'loading'
  }

  /**
   * Vite re-imported modules: a source change from anywhere (an IDE save, another client), whose
   * render may already have happened (resource timing is delivered late), or follows shortly.
   */
  private onHotUpdate(modules: HotModule[]): void {
    const now = performance.now()
    this.hot = [...this.hot.filter((m) => m.arrivedAt > now - HOT_MEMORY_MS), ...modules]
    if (!this.pending) {
      this.edit = null
      this.triggeredAt = now
      this.renderedAfter = now - EARLY_MS
      this.pending = true
    }
    // React renders a re-imported module a moment after it runs: give that render time to show.
    this.floorAt = Math.max(this.floorAt, now + QUIET_MS)
    this.armSettle(0)
  }

  /**
   * When the awaited edit's own hot update arrived: a re-import of every file it wrote (Vite
   * serves `/<project-relative path>`), each requested after the edit was sent. The latest
   * arrival, or null while any file has none.
   */
  private editArrivedAt(): number | null {
    const edit = this.edit
    if (!edit || edit.files.length === 0) return null
    let latest = -Infinity
    for (const file of edit.files) {
      let arrived = -Infinity
      if (this.usesResourceTiming()) {
        for (const m of this.hot) if (m.requestedAt >= edit.sentAt && m.path === `/${file}`) arrived = m.arrivedAt
      } else {
        arrived = this.fileRenders.get(file) ?? -Infinity
      }
      if (arrived < edit.sentAt) return null
      latest = Math.max(latest, arrived)
    }
    return latest
  }

  private onMutations(records: MutationRecord[]): void {
    // Only the document outside <head> renders the app (and carries its locators). Vite can
    // apply a stylesheet's hot update (Tailwind's output) in a batch of its own, before the
    // module that re-renders the DOM, so <head> changes don't count as an update's render.
    // They still move boxes, hence the layout either way. The armed check reads the time; a
    // mutation must not re-arm it, or an app that never stops changing would never settle.
    const counts = (r: MutationRecord) => !this.isOwnMutation(r) && !inHead(r.target)
    if (this.usesResourceTiming()) {
      if (records.some(counts)) this.lastMutationAt = performance.now()
    } else {
      const now = performance.now()
      for (const record of records) {
        if (!counts(record)) continue
        this.lastMutationAt = now
        for (const element of affectedElements(record)) {
          const file = locatorFile(element.getAttribute('data-ast-node') ?? '')
          if (file) this.fileRenders.set(file, now)
        }
      }
    }
    this.scheduleLayout()
  }

  private armSettle(delay: number): void {
    clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(() => this.checkSettle(), Math.max(0, delay))
  }

  private checkSettle(): void {
    if (!this.pending) return
    const now = performance.now()
    const settleAt = this.settleAt()
    if (now >= settleAt) {
      this.pending = false
      this.edit = null
      this.listener.settled()
      this.scheduleLayout()
      return
    }
    // Look again at least every QUIET_MS: a render (or a hot update) may come at any moment.
    this.armSettle(Math.min(settleAt, now + QUIET_MS) - now)
  }

  /**
   * When the awaited update counts as rendered: once the DOM has changed since its render could
   * begin and then stayed quiet for QUIET_MS. Its render can begin when the designer's own edit's
   * hot update arrived (see expectUpdate), otherwise at the trigger. A DOM that never goes quiet
   * (an app that animates or ticks) settles BUSY_MS after the render could begin; so does one
   * that doesn't change at all after the edit's hot update (an edit that renders the same).
   * Never later than MAX_WAIT_MS after the trigger (a hot update that never comes), never before
   * `floorAt`.
   */
  private settleAt(): number {
    const latest = this.triggeredAt + MAX_WAIT_MS
    let at: number
    if (this.edit) {
      const arrived = this.editArrivedAt()
      at =
        arrived === null
          ? latest
          : this.lastMutationAt >= arrived
            ? Math.min(this.lastMutationAt + QUIET_MS, arrived + BUSY_MS)
            : arrived + BUSY_MS
    } else {
      at =
        this.lastMutationAt >= this.renderedAfter
          ? Math.min(this.lastMutationAt + QUIET_MS, this.triggeredAt + BUSY_MS)
          : latest
    }
    return Math.max(this.floorAt, Math.min(latest, at))
  }
}

/** Stamped elements a render changed or replaced (including a removed subtree). */
function* affectedElements(record: MutationRecord): Iterable<Element> {
  const selector = '[data-ast-node]'
  const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target as Element : record.target.parentElement
  const owner = target?.closest(selector)
  if (owner) yield owner
  for (const node of [...record.addedNodes, ...record.removedNodes]) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue
    const element = node as Element
    if (element.matches(selector)) yield element
    yield* element.querySelectorAll(selector)
  }
}

function inHead(node: Node): boolean {
  return node.ownerDocument?.head?.contains(node) ?? false
}

/**
 * The URL path of a module (or CSS) Vite re-imported for a hot update: same origin as the app,
 * with `t=<timestamp>`. Null for any other resource.
 */
function hotUpdatePath(name: string, origin: string): string | null {
  let url: URL
  try {
    url = new URL(name)
  } catch {
    return null
  }
  if (url.origin !== origin || !/^\d{10,}$/.test(url.searchParams.get('t') ?? '')) return null
  try {
    return decodeURIComponent(url.pathname)
  } catch {
    return url.pathname
  }
}
