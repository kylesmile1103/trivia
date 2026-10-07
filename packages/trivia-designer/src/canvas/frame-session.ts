// The canvas's binding to the user's document in the iframe: observes it (never injects
// listeners into its React elements) and reports two things to the canvas:
//
// - `layout`: geometry may have changed (scroll in any container, resize, layout shifts, DOM
//   mutation, previews). Coalesced to one call per animation frame.
// - `settled`: the app finished re-rendering after a source change (HMR). A change is expected
//   when Vite re-imports a module (`?t=<timestamp>`, visible in the iframe's resource timeline)
//   or when the designer's own edit returns; it has settled once DOM mutations go quiet.

/** Mutations must pause this long before an update counts as rendered. */
const QUIET_MS = 120
/** Resource timing is delivered late: mutations this long before the trigger still count. */
const EARLY_MS = 300
/** Settle anyway after this long (a no-op edit, or an app that mutates constantly). */
const MAX_WAIT_MS = 1500
/** Re-measure every frame this long after a CSS transition/animation starts (boxes follow it). */
const ANIMATION_FOLLOW_MS = 1000

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
  private lastMutationAt = -Infinity
  private settleTimer = 0
  private animatingUntil = 0

  private readonly iframe: HTMLIFrameElement
  private readonly listener: FrameListener

  constructor(iframe: HTMLIFrameElement, listener: FrameListener) {
    this.iframe = iframe
    this.listener = listener
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

  /** A source change is on its way (e.g. the designer's own edit just returned). */
  expectUpdate(): void {
    if (!this.pending) {
      this.pending = true
      this.triggeredAt = performance.now()
    }
    this.armSettle(QUIET_MS)
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
    const hot = new win.PerformanceObserver((list) => {
      if (list.getEntries().some((entry) => isHotUpdate(entry.name, win.location.origin))) this.expectUpdate()
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
    this.doc = null
    this.tracked = []
    if (this.state === 'attached') this.state = 'loading'
  }

  private onMutations(records: MutationRecord[]): void {
    if (records.some((r) => !this.isOwnMutation(r))) {
      this.lastMutationAt = performance.now()
      if (this.pending) this.armSettle(QUIET_MS)
    }
    this.scheduleLayout()
  }

  private armSettle(delay: number): void {
    clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(() => this.checkSettle(), delay)
  }

  private checkSettle(): void {
    if (!this.pending) return
    const now = performance.now()
    const sinceMutation = now - this.lastMutationAt
    const rendered = this.lastMutationAt >= this.triggeredAt - EARLY_MS
    if ((rendered && sinceMutation >= QUIET_MS) || now - this.triggeredAt >= MAX_WAIT_MS) {
      this.pending = false
      this.listener.settled()
      this.scheduleLayout()
      return
    }
    this.armSettle(rendered ? Math.max(16, QUIET_MS - sinceMutation) : QUIET_MS)
  }
}

/** Vite re-imports hot-updated modules (and CSS) from the app's origin with `t=<timestamp>`. */
function isHotUpdate(name: string, origin: string): boolean {
  let url: URL
  try {
    url = new URL(name)
  } catch {
    return false
  }
  return url.origin === origin && /^\d{10,}$/.test(url.searchParams.get('t') ?? '')
}
