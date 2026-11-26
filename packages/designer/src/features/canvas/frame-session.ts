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
//
// A Next.js document also catches up once (LLD-13 §6). Next 16.4.6 can leave a document on
// the source as it was before an edit written while it loaded: a hot update that reaches it
// before its React root first commits is lost (React Refresh re-renders only mounted roots), and
// one written before its HMR socket subscribed may never reach it. So once it has hydrated, the
// session reads when the dev service last wrote. A write since the document began to load:
// reload it, but not before COMPILE_GRACE_MS after the write (a document requested sooner is
// rendered from the old code); a reloaded document also counts a write in the grace before its
// own start, and a chain reloads at most twice (`reloadsInChain`). Otherwise: ask the app's
// router for a fresh render. The canvas is busy (`updating`) from the session's start or a
// document's unload until that render, so the first press lands on what is on disk. The Next
// internals this needs are in next-hydration.ts. Each wait is bounded: a document to attach and
// to hydrate CATCH_UP_TIMEOUT_MS, the read READ_TIMEOUT_MS, the grace COMPILE_GRACE_MS, the
// refresh CATCH_UP_TIMEOUT_MS. The service and the browser share a host and its clock: a skew
// can cost a needless reload or miss one, never a loop.

import { locatorFile } from '@/shared/lib/locator'

import { COMPILE_GRACE_MS, NEXT_VERIFIED, isRouterRequest, refreshRouter, reloadDocument, whenHydrated } from './next-hydration'

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
/** How long a Next document may take to attach, to hydrate, and its catch-up refresh to answer. */
const CATCH_UP_TIMEOUT_MS = 10_000
/** How long the catch-up waits for the dev service's last write time. */
const READ_TIMEOUT_MS = 1000
/** Catch-up reloads in one chain at most; after them, a document that missed a write is refreshed. */
const MAX_RELOADS = 2

/**
 * A Next document's catch-up: waiting for it to hydrate, reading when the service last wrote,
 * then waiting for the router refresh to render, or for the document to reload.
 */
interface CatchUp {
  phase: 'hydrating' | 'reading' | 'refreshing' | 'reloading'
  /** How many catch-up reloads led to this document (0 for one the user or Next loaded). */
  reloads: number
  stopWaiting: () => void
  /** Ends the phase that is taking too long. */
  timeout: number
  /** Re-checks whether the refresh has rendered. */
  check: number
  /** When the refresh was asked for (designer clock). */
  refreshedAt: number
  /** When the router's request for it answered (designer clock), once it has. */
  answeredAt: number | null
}

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
  /**
   * When the dev service last wrote the project (ms since the epoch, null before its first
   * write), read fresh: a Next document's catch-up asks once it has hydrated.
   */
  lastWrite?(): Promise<number | null>
  /** No Next document attached within CATCH_UP_TIMEOUT_MS of the start or of an unload. */
  loadTimedOut?(): void
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
  /** The attached Next document's catch-up, while it lasts. */
  private catchUp: CatchUp | null = null
  /** Between the start or an unload and the next attach (Next only), until CATCH_UP_TIMEOUT_MS. */
  private awaitingDocument = false
  private documentTimer = 0
  /** Catch-up reloads that led to the document still to come: 0, 1 or MAX_RELOADS. */
  private reloadsInChain = 0

  private readonly iframe: HTMLIFrameElement
  private readonly listener: FrameListener
  private readonly usesResourceTiming: () => boolean
  private readonly catchesUp: () => boolean

  /**
   * `usesResourceTiming`: the app's dev server is Vite, whose hot updates show as module
   * requests. `catchesUp`: it is Next.js, whose documents catch up once they have hydrated.
   * The canvas mounts once the engine's health is known, so both are settled by the first attach.
   */
  constructor(
    iframe: HTMLIFrameElement,
    listener: FrameListener,
    usesResourceTiming: () => boolean = () => true,
    catchesUp: () => boolean = () => false,
  ) {
    this.iframe = iframe
    this.listener = listener
    this.usesResourceTiming = usesResourceTiming
    this.catchesUp = catchesUp
  }

  /** Attach now if the document already loaded, and on every later load. Returns the stop function. */
  start(): () => void {
    this.awaitDocument()
    const onLoad = () => this.attach()
    this.iframe.addEventListener('load', onLoad)
    const win = this.iframe.contentWindow
    if (win && this.iframe.contentDocument?.readyState === 'complete' && win.location.href !== 'about:blank') this.attach()
    return () => {
      this.iframe.removeEventListener('load', onLoad)
      this.detach()
      this.stopAwaitingDocument()
    }
  }

  /**
   * True between an expected update and its settle, and while a Next document loads and catches
   * up: until then the canvas shows the server's HTML, which can be older than the source.
   */
  get updating(): boolean {
    return this.pending || this.catchUp !== null || this.awaitingDocument
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
      const entries = list.getEntries() as PerformanceResourceTiming[]
      const catchUp = this.catchUp
      if (catchUp?.phase === 'refreshing' && catchUp.answeredAt === null) {
        for (const entry of entries) {
          if (!isRouterRequest(entry.name, win.location) || entry.startTime + offset < catchUp.refreshedAt) continue
          catchUp.answeredAt = (entry.responseEnd || entry.startTime + entry.duration) + offset
          this.checkCatchUp()
          break
        }
      }
      if (!this.usesResourceTiming()) return
      const modules: HotModule[] = []
      for (const entry of entries) {
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

    this.stopAwaitingDocument()
    const reloads = this.reloadsInChain
    this.reloadsInChain = 0
    this.listener.attached()
    if (this.catchesUp()) this.startCatchUp(doc, win, reloads)
    this.scheduleLayout()
  }

  // ---------------------------------------------------------------------------------------
  // A Next document's catch-up: once per document, never for a client-side navigation (the
  // document stays) and again after a full reload (a new one attaches).

  private startCatchUp(doc: Document, win: Window, reloads: number): void {
    const catchUp: CatchUp = { phase: 'hydrating', reloads, stopWaiting: () => {}, timeout: 0, check: 0, refreshedAt: 0, answeredAt: null }
    this.catchUp = catchUp
    catchUp.timeout = window.setTimeout(() => this.endCatchUp(`the page did not hydrate within ${CATCH_UP_TIMEOUT_MS / 1000} s (no <next-route-announcer>)`), CATCH_UP_TIMEOUT_MS)
    const stop = whenHydrated(doc, () => this.onHydrated(catchUp, win))
    if (this.catchUp === catchUp && catchUp.phase === 'hydrating') catchUp.stopWaiting = stop
  }

  /** Hydrated: read when the service last wrote (READ_TIMEOUT_MS; a failure or no answer reads as none). */
  private onHydrated(catchUp: CatchUp, win: Window): void {
    if (this.catchUp !== catchUp) return
    catchUp.phase = 'reading'
    clearTimeout(catchUp.timeout)
    const listener = this.listener
    if (!listener.lastWrite) {
      this.catchUpWith(catchUp, win, null)
      return
    }
    let answered = false
    const answer = (at: number | null) => {
      if (answered) return
      answered = true
      clearTimeout(catchUp.timeout)
      this.catchUpWith(catchUp, win, at)
    }
    catchUp.timeout = window.setTimeout(() => answer(null), READ_TIMEOUT_MS)
    listener.lastWrite().then(answer, () => answer(null))
  }

  /**
   * A write at or after the document's navigation start may be missing from it (both are ms
   * since the epoch; the read comes after hydration, which bounds the window). A catch-up
   * reload's document may also miss one written up to COMPILE_GRACE_MS before it began: the
   * grace is a measurement, not a guarantee. Reload then, no sooner than the grace after the
   * write (the wait clamped to the grace, against a skewed clock), unless the chain has reloaded
   * MAX_RELOADS times; refresh otherwise.
   */
  private catchUpWith(catchUp: CatchUp, win: Window, lastWriteAt: number | null): void {
    if (this.catchUp !== catchUp) return
    const start = Math.floor(win.performance.timeOrigin) - (catchUp.reloads > 0 ? COMPILE_GRACE_MS : 0)
    const missed = lastWriteAt !== null && lastWriteAt >= start
    if (missed && catchUp.reloads < MAX_RELOADS) {
      catchUp.phase = 'reloading'
      // Busy until the reload unloads this document (detach), then until the next one attaches.
      catchUp.timeout = window.setTimeout(() => {
        this.reloadsInChain = 0
        this.endCatchUp(`the page did not reload within ${CATCH_UP_TIMEOUT_MS / 1000} s`)
      }, CATCH_UP_TIMEOUT_MS)
      const wait = Math.min(COMPILE_GRACE_MS, Math.max(0, lastWriteAt + COMPILE_GRACE_MS - Date.now()))
      catchUp.check = window.setTimeout(() => {
        if (this.catchUp !== catchUp) return // unloaded or stopped meanwhile
        this.reloadsInChain = catchUp.reloads + 1
        reloadDocument(win)
      }, wait)
      return
    }
    if (missed) {
      console.warn(
        `[trivia] The dev service wrote the Next.js app again while the canvas reloaded it ${MAX_RELOADS} times to catch up. ` +
          `The canvas refreshes it instead of reloading it again (Next.js ${NEXT_VERIFIED}); an edit written while the page ` +
          'loaded may not show until the next reload.',
      )
    }
    const problem = refreshRouter(win)
    if (problem !== null) {
      this.endCatchUp(problem)
      return
    }
    catchUp.phase = 'refreshing'
    catchUp.refreshedAt = performance.now()
    catchUp.timeout = window.setTimeout(() => this.endCatchUp(`the router refresh did not answer within ${CATCH_UP_TIMEOUT_MS / 1000} s`), CATCH_UP_TIMEOUT_MS)
    this.scheduleLayout()
  }

  /**
   * The refresh has rendered once the DOM has been quiet for QUIET_MS after its answer arrived
   * (usually it changes nothing: the document was current), or BUSY_MS after the answer if the
   * app never goes quiet.
   */
  private checkCatchUp(): void {
    const catchUp = this.catchUp
    if (!catchUp || catchUp.phase !== 'refreshing' || catchUp.answeredAt === null) return
    clearTimeout(catchUp.check)
    const answered = catchUp.answeredAt
    const at = this.lastMutationAt >= answered ? Math.min(this.lastMutationAt + QUIET_MS, answered + BUSY_MS) : answered + QUIET_MS
    const now = performance.now()
    if (now >= at) {
      this.endCatchUp(null)
      return
    }
    catchUp.check = window.setTimeout(() => this.checkCatchUp(), Math.min(at, now + QUIET_MS) - now)
  }

  /** The catch-up is over (`problem` says why it was cut short): the canvas is current, or as current as it gets. */
  private endCatchUp(problem: string | null): void {
    if (!this.catchUp) return
    this.stopCatchUp()
    if (problem !== null) {
      console.warn(
        `[trivia] The canvas skipped its catch-up of the Next.js app: ${problem}. It relies on Next.js ${NEXT_VERIFIED} ` +
          'internals (<next-route-announcer>, window.next.router.refresh()); an edit written while the page was loading may not ' +
          'show on the canvas until the page reloads.',
      )
    }
    // The refresh may have rendered a missed edit: the canvas re-reads the DOM, as after HMR.
    // An edit still on its way (one the read noticed) settles on its own, and says so then.
    if (!this.pending) this.listener.settled()
    this.scheduleLayout()
  }

  /** From the start, or an unload, until a Next document attaches: at most CATCH_UP_TIMEOUT_MS. */
  private awaitDocument(): void {
    if (!this.catchesUp()) return
    this.awaitingDocument = true
    clearTimeout(this.documentTimer)
    this.documentTimer = window.setTimeout(() => {
      this.awaitingDocument = false
      this.reloadsInChain = 0
      // No warning: the canvas's own status says the app has not loaded.
      this.listener.loadTimedOut?.()
      this.scheduleLayout()
    }, CATCH_UP_TIMEOUT_MS)
  }

  private stopAwaitingDocument(): void {
    this.awaitingDocument = false
    clearTimeout(this.documentTimer)
  }

  private stopCatchUp(): void {
    const catchUp = this.catchUp
    if (!catchUp) return
    this.catchUp = null
    catchUp.stopWaiting()
    clearTimeout(catchUp.timeout)
    clearTimeout(catchUp.check)
  }

  private detach(): void {
    const wasAttached = this.state === 'attached'
    this.stopCatchUp()
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
    // A Next document unloaded (a full reload, a navigation): the next one is still to come.
    if (wasAttached) this.awaitDocument()
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
