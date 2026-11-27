// @vitest-environment jsdom
//
// The canvas controller against the real FrameSession, store and action bus; the engine is a
// fetch stub with positional locators and expected-name guards (engine ops/mod.rs), and the app's
// document is rendered by hand. That makes the window between an edit returning and its HMR
// rendering explicit: the DOM still carries the locators of the old source, so a locator read
// from it names whatever sits at that position in the new one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => [] as string[])
vi.mock('sonner', () => {
  const say = (kind: string) => (message: unknown, options?: { description?: string }) => {
    toasts.push(`${kind}: ${String(message)}${options?.description ? ` — ${options.description}` : ''}`)
  }
  return {
    toast: Object.assign(say('message'), { error: say('error'), info: say('info'), success: say('success'), warning: say('warning') }),
  }
})
// jsdom cannot reload a document: a Next catch-up that would is noted (frame-session.test.ts covers it).
const reloads = vi.hoisted(() => [] as Window[])
vi.mock('./reload-document', () => ({
  reloadDocument: (win: Window) => {
    reloads.push(win)
  },
}))

import { engine as client } from '@/shared/engine/client'
import type { ApplyResult, HistoryState, NodeDetails, Op, Placement } from '@/shared/engine/types'
import { designer } from '@/shared/state/store'
import { TEMPLATE_MIME, type Template } from '@/shared/template'

import { type CanvasView, CanvasController, EMPTY_VIEW } from './controller'

const FILE = 'src/Page.tsx'
const at = (path: string) => `${FILE}#Page#${path}`
const ROOT = at('0')

class EngineError extends Error {
  code: string
  status: number

  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * The engine reduced to one root <div> whose children are `name#id` strings: the id only lets
 * a test tell same-named siblings apart; the engine itself sees names, like the real one.
 */
class FakeEngine {
  children: string[] = []
  /** Every op the designer sent, refused or not. */
  readonly ops: Op[] = []
  /** While set, applies wait for it: the edit is on its way to disk. */
  hold: Promise<void> | null = null
  /** While set, an apply is written at once but its reply waits for it (a slow answer). */
  delayReply: Promise<void> | null = null
  /** Indices of children rendered from a `{…}` expression (`isDirect: false`). */
  readonly indirect = new Set<number>()
  /** What `/history` answers: the state after the last apply. */
  history: HistoryState = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }
  private entries = 0

  private indexOf(locator: string): number {
    const m = /#0\.(\d+)$/.exec(locator)
    const i = m ? Number(m[1]) : -1
    if (i < 0 || i >= this.children.length) throw new EngineError('node_not_found', 404, `no node at ${locator}`)
    return i
  }

  nameAt(locator: string): string {
    return locator === ROOT ? 'div' : nameOf(this.children[this.indexOf(locator)]!)
  }

  inspect(locator: string): NodeDetails {
    const isRoot = locator === ROOT
    return {
      locator,
      file: FILE,
      name: this.nameAt(locator),
      isFragment: false,
      line: 1,
      column: 1,
      isRoot,
      isDirect: isRoot || !this.indirect.has(this.indexOf(locator)),
      parent: isRoot ? null : ROOT,
      children: isRoot ? this.children.map((_, i) => at(`0.${i}`)) : [],
      attributes: [],
      text: null,
    }
  }

  apply(op: Op, label: string): ApplyResult {
    this.ops.push(op)
    const list = [...this.children]
    let placed: number | null = null
    if (op.op === 'remove') {
      this.guard(op.target, op.expectedName)
      list.splice(this.indexOf(op.target), 1)
    } else if (op.op === 'move') {
      this.guard(op.source, op.expectedName)
      this.guard(op.target, op.expectedTargetName)
      const from = this.indexOf(op.source)
      const [moved] = list.splice(from, 1)
      placed = this.slot(list, op.target, op.placement, from)
      list.splice(placed, 0, moved!)
    } else if (op.op === 'insert') {
      this.guard(op.target, op.expectedName)
      placed = this.slot(list, op.target, op.placement, -1)
      list.splice(placed, 0, /^<([\w.]+)/.exec(op.snippet)?.[1] ?? '?')
    } else {
      throw new EngineError('unsupported', 422, `the fake engine has no ${op.op}`)
    }
    this.children = list
    const history: HistoryState = {
      canUndo: true, canRedo: false, undoLabel: `${label} #${++this.entries}`, redoLabel: null, lastWriteAt: Date.now(),
    }
    this.history = history
    return { file: FILE, changed: true, locator: placed === null ? null : at(`0.${placed}`), history }
  }

  /** The engine's `resolve_expected` (locator.rs): a locator that now names another element is a 409. */
  private guard(locator: string, expected: string | undefined): void {
    const actual = this.nameAt(locator)
    if (expected !== undefined && actual !== expected) {
      throw new EngineError('stale_locator', 409, `expected <${expected}> at ${locator}, found <${actual}>`)
    }
  }

  /** Where a node placed relative to `target` lands in `list` (the moved node already taken out at `removed`). */
  private slot(list: string[], target: string, placement: Placement, removed: number): number {
    if (target === ROOT) return placement === 'firstChild' ? 0 : list.length
    let i = this.indexOf(target)
    if (removed >= 0 && removed < i) i -= 1
    return placement === 'before' ? i : i + 1
  }
}

const nameOf = (child: string) => child.split('#')[0]!

function serve(engine: FakeEngine): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace(/^\/@trivia\/api/, '')
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    try {
      if (path === '/inspect') return reply({ ok: true, data: engine.inspect(url.searchParams.get('locator') ?? '') })
      if (path === '/history') return reply({ ok: true, data: engine.history })
      if (path === '/apply') {
        const { op, label } = JSON.parse(String(init?.body)) as { op: Op; label: string }
        await engine.hold
        const result = engine.apply(op, label)
        await engine.delayReply
        return reply({ ok: true, data: result })
      }
    } catch (error) {
      if (error instanceof EngineError) return reply({ ok: false, error: { code: error.code, message: error.message } }, error.status)
      throw error
    }
    throw new Error(`the fake engine has no ${path}`)
  }) as typeof fetch
}

// ---------------------------------------------------------------------------------------------
// The app's document. jsdom has no layout: boxes come from data-rect, hit-testing from those.

type FrameWindow = Window & typeof globalThis
interface AppDocument {
  win: FrameWindow
  doc: Document
  /** The canvas's resource-timing observers on this document (FrameSession watches for hot updates). */
  resources: Array<(list: { getEntries(): Array<{ name: string; startTime: number; responseEnd: number }> }) => void>
}

const ROW = 30
/** Child `i` is drawn as a 200×20 row at y = 10 + 30i (frame, client and overlay coordinates coincide). */
function pointOf(i: number, part: 'top' | 'middle' | 'bottom' = 'middle') {
  return { x: 50, y: 10 + ROW * i + (part === 'top' ? 3 : part === 'bottom' ? 17 : 10) }
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect
}

function appDocument(): AppDocument {
  const host = document.createElement('iframe')
  document.body.append(host)
  const win = host.contentWindow as FrameWindow
  const doc = host.contentDocument!
  const resources: AppDocument['resources'] = []
  Object.assign(win, {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    PerformanceObserver: class {
      private readonly callback: AppDocument['resources'][number]
      constructor(callback: AppDocument['resources'][number]) {
        this.callback = callback
      }
      observe() {
        resources.push(this.callback)
      }
      disconnect() {
        resources.splice(resources.indexOf(this.callback) >>> 0, 1)
      }
    },
    // The Vite plugin's HMR probe, answered: the page's socket is open (vite-hmr.ts).
    __TRIVIA_HMR__: { ready: true },
  })
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    const [x = 0, y = 0, w = 0, h = 0] = (this.getAttribute('data-rect') ?? '').split(',').map(Number)
    return rect(x, y, w, h)
  }
  const inside = (el: Element, x: number, y: number) => {
    const r = el.getBoundingClientRect()
    return x >= r.left && x < r.right && y >= r.top && y < r.bottom
  }
  doc.elementsFromPoint = (x: number, y: number) => [...doc.querySelectorAll('[data-rect]')].filter((el) => inside(el, x, y)).reverse()
  return { win, doc, resources }
}

/** What the locator plugin and React would render for `children`. */
function render(app: AppDocument, children: readonly string[]): void {
  const rows = children.map((child, i) => {
    const tag = nameOf(child)
    return `<${tag} data-ast-node="${at(`0.${i}`)}" data-rect="10,${10 + ROW * i},200,20">${child}</${tag}>`
  })
  // Next's route announcer sits in <body> beside the app's own render, which leaves it alone.
  const announcer = app.doc.querySelector('next-route-announcer')
  app.doc.body.innerHTML = `<div data-ast-node="${ROOT}" data-rect="0,0,400,${20 + ROW * children.length}">${rows.join('')}</div>`
  if (announcer) app.doc.body.append(announcer)
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
/** Let fetches, store updates and the canvas's per-frame layout run. */
async function idle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await frame()
    await tick()
  }
}
/** Past FrameSession's QUIET_MS after the last mutation, well before MAX_WAIT_MS. */
async function quiet(): Promise<void> {
  await tick(250)
  await idle()
}

/**
 * The inspector's useSelectedDetails, reduced: refetch the selection's details when it changes
 * and on every canvas revision (HMR), latest request wins.
 */
function followSelection(): () => void {
  let latest = 0
  return designer.subscribe((s, prev) => {
    if (s.selected === null || (s.selected === prev.selected && s.revision === prev.revision)) return
    const locator = s.selected
    const request = ++latest
    const store = (details: NodeDetails | null) => {
      if (request === latest && designer.getState().selected === locator) designer.getState().setDetails(details)
    }
    client.inspect(locator).then(store, () => store(null))
  })
}

/**
 * `prepare` sets up each document the canvas will attach (the first and every reload); with
 * `loaded: false` the first document's load event waits for `load()`.
 */
function mountCanvas(
  engine: FakeEngine,
  renderImmediately = true,
  { prepare = () => {}, loaded = true }: { prepare?: (app: AppDocument) => void; loaded?: boolean } = {},
) {
  let app = appDocument()
  prepare(app)
  if (renderImmediately) render(app, engine.children)
  // Never attached to the document, so it has no browsing context of its own and never fires a
  // load event the test didn't send; its document is whichever `app` is current.
  const iframe = document.createElement('iframe')
  Object.defineProperty(iframe, 'contentWindow', { get: () => app.win })
  Object.defineProperty(iframe, 'contentDocument', { get: () => app.doc })
  Object.defineProperty(iframe, 'offsetWidth', { get: () => 800 })
  iframe.getBoundingClientRect = () => rect(0, 0, 800, 600)
  const overlay = document.createElement('div')
  document.body.append(overlay)
  Object.assign(overlay, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false })

  const views: CanvasView[] = []
  const controller = new CanvasController(iframe, overlay, (view) => views.push(view))
  const unmount = controller.mount()
  const unfollow = followSelection()
  if (loaded) iframe.dispatchEvent(new Event('load'))

  type Point = { x: number; y: number }
  const pointer = (type: string, p: Point) =>
    overlay.dispatchEvent(new PointerEvent(type, { button: 0, clientX: p.x, clientY: p.y, pointerId: 1, bubbles: true }))
  const dragEvent = (type: string, p: Point, template: Template) => {
    const event = new MouseEvent(type, { clientX: p.x, clientY: p.y, bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: [TEMPLATE_MIME], getData: () => JSON.stringify(template), dropEffect: 'none' },
    })
    overlay.dispatchEvent(event)
  }

  return {
    view: (): CanvasView => views.at(-1) ?? EMPTY_VIEW,
    /** Every view the canvas published, oldest first. */
    views: (): readonly CanvasView[] => views,
    /** The first document finished loading (with `loaded: false`). */
    load: () => iframe.dispatchEvent(new Event('load')),
    doc: () => app.doc,
    renderFromSource: () => render(app, engine.children),
    /** HMR: Vite re-imports the page's module, and React re-renders the app from the source as it is now. */
    hmr() {
      this.hotUpdate(FILE)
      render(app, engine.children)
    },
    /**
     * Vite re-imported `file` (`?t=`), as the app's resource timeline reports it: fetched just now,
     * requested `requestedAgo` ms earlier. Times are in the app document's own clock. jsdom's
     * frame has origin "null", which file: URLs share, so the entry is same-origin as Vite's are.
     */
    hotUpdate(file: string, requestedAgo = 10) {
      const now = app.win.performance.now()
      const entry = { name: `file:///${file}?t=${Date.now()}`, startTime: now - requestedAgo, responseEnd: now }
      for (const observer of [...app.resources]) observer({ getEntries: () => [entry] })
    },
    /** Vite reloads the page instead: a new document renders the source as it is now. */
    reload: () => {
      app.win.dispatchEvent(new Event('pagehide'))
      app = appDocument()
      prepare(app)
      render(app, engine.children)
      iframe.dispatchEvent(new Event('load'))
    },
    /** Next's App Router committed its first render: its route announcer is in the document. */
    hydrate: () => {
      app.doc.body.append(app.doc.createElement('next-route-announcer'))
    },
    /** The App Router's RSC request for this page answered (`?_rsc=`), as resource timing reports it. */
    routerAnswered() {
      const now = app.win.performance.now()
      const entry = { name: `${app.win.location.href}?_rsc=1a2b3`, startTime: now, responseEnd: now }
      for (const observer of [...app.resources]) observer({ getEntries: () => [entry] })
    },
    pointer,
    async click(p: Point) {
      pointer('pointerdown', p)
      pointer('pointerup', p)
      await idle()
    },
    /** Press on `from`, pass the drag threshold, hover `to`. */
    async grab(from: Point, to: Point) {
      pointer('pointerdown', from)
      pointer('pointermove', { x: from.x + 8, y: from.y })
      await idle()
      pointer('pointermove', to)
      await idle()
    },
    async drag(from: Point, to: Point) {
      await this.grab(from, to)
      pointer('pointerup', to)
      await idle()
    },
    /** A right-click; true when the browser's own menu was suppressed. */
    async rightClick(p: Point): Promise<boolean> {
      const event = new MouseEvent('contextmenu', { button: 2, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true })
      overlay.dispatchEvent(event)
      await idle()
      return event.defaultPrevented
    },
    controller,
    async press(key: string) {
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      await idle()
    },
    /** A palette drag: the shell publishes the template, the canvas sees it arrive over the overlay. */
    async dragTemplateOver(p: Point, template: Template) {
      designer.getState().setDrag({ kind: 'palette', template })
      dragEvent('dragover', p, template)
      await idle()
    },
    async dropTemplate(p: Point, template: Template) {
      dragEvent('drop', p, template)
      await idle()
    },
    unmount() {
      unfollow()
      unmount()
      overlay.remove()
    },
  }
}

const BADGE: Template = {
  component: 'Badge',
  label: 'Badge',
  snippet: '<Badge>New</Badge>',
  imports: [{ name: 'Badge', source: '@/components/ui/badge' }],
}

let engine: FakeEngine
let canvas: ReturnType<typeof mountCanvas> | null = null

beforeEach(() => {
  engine = new FakeEngine()
  toasts.length = 0
  vi.stubGlobal('fetch', serve(engine))
  designer.setState({
    health: { root: '/app', uiDir: 'src/components/ui', importBase: '@/components/ui', version: 'test' },
    selected: null,
    hovered: null,
    details: null,
    drag: null,
    drop: null,
    mode: 'design',
    zoom: 1,
    expectedSelectedName: null,
    pressPending: false,
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    lastEdit: null,
  })
})

afterEach(() => {
  canvas?.unmount()
  canvas = null
  vi.unstubAllGlobals()
})

async function open(children: string[]) {
  engine.children = children
  canvas = mountCanvas(engine)
  await idle()
  return canvas
}

it('refreshes the Layers snapshot when a loaded document renders its first locators later', async () => {
  engine.children = ['button']
  canvas = mountCanvas(engine, false)
  await idle()
  expect(canvas.controller.api.layers()).toEqual([])
  const revision = designer.getState().revision

  canvas.renderFromSource()
  await idle()

  expect(canvas.view().status).toBe('ready')
  expect(designer.getState().revision).toBe(revision + 1)
  expect(canvas.controller.api.layers()[0]).toMatchObject({ locator: ROOT })
})

describe('gestures made before an edit has rendered', () => {
  it('a drag is refused, then moves the node the user grabbed once the app re-rendered', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.drag(pointOf(1), pointOf(0, 'top')) // the <button> before the <h2>
    expect(engine.ops[0]).toMatchObject({ op: 'move', source: at('0.1'), expectedName: 'button', target: at('0.0'), placement: 'before' })
    expect(engine.children).toEqual(['button', 'h2', 'p'])

    // HMR hasn't rendered: the <h2> on the canvas is still stamped #0.0, the <button> on disk.
    await c.drag(pointOf(0), pointOf(2, 'bottom')) // grab the <h2>, drop it after the <p>
    expect(engine.children).toEqual(['button', 'h2', 'p'])
    expect(engine.ops).toHaveLength(1)
    expect(c.view().updating).toBe(true)

    c.hmr()
    await quiet()
    expect(c.view().updating).toBe(false)
    await c.drag(pointOf(1), pointOf(2, 'bottom')) // the same <h2>, now stamped #0.1
    expect(engine.ops.at(-1)).toEqual({
      op: 'move',
      source: at('0.1'),
      expectedName: 'h2',
      target: at('0.2'),
      expectedTargetName: 'p',
      placement: 'after',
    })
    expect(engine.children).toEqual(['button', 'p', 'h2'])
  })

  it('Delete on a node clicked in that window is refused, and says why', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.drag(pointOf(1), pointOf(0, 'top'))
    await c.click(pointOf(0)) // the <h2>, still stamped #0.0
    await c.press('Delete')
    expect(engine.children).toEqual(['button', 'h2', 'p'])
    expect(engine.ops).toHaveLength(1)
    expect(toasts.some((t) => /still updating/.test(t))).toBe(true)

    c.hmr()
    await quiet()
    await c.click(pointOf(1))
    await c.press('Delete')
    expect(engine.ops.at(-1)).toEqual({ op: 'remove', target: at('0.1'), expectedName: 'h2' })
    expect(engine.children).toEqual(['button', 'p'])
  })

  it('a click right after a Delete does not select what slid into the deleted position', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.click(pointOf(0))
    await c.press('Delete')
    expect(engine.children).toEqual(['button', 'p'])
    await c.click(pointOf(1)) // the <button> on the canvas, stamped #0.1: the <p> on disk
    await c.press('Delete')
    expect(engine.children).toEqual(['button', 'p'])
    expect(engine.ops).toHaveLength(1)

    c.hmr()
    await quiet()
    await c.click(pointOf(0))
    await c.press('Delete')
    expect(engine.ops.at(-1)).toEqual({ op: 'remove', target: at('0.0'), expectedName: 'button' })
    expect(engine.children).toEqual(['p'])
  })

  it('a second Delete while the first is still on its way is refused', async () => {
    const c = await open(['button#a', 'button#b', 'p'])
    await c.click(pointOf(0))
    let release = () => {}
    engine.hold = new Promise((resolve) => (release = resolve))
    await c.press('Delete')
    await c.press('Delete') // same locator, same name: the engine can't tell it now means #b
    release()
    engine.hold = null
    await idle()
    expect(engine.ops).toHaveLength(1)
    expect(engine.children).toEqual(['button#b', 'p'])
  })

  it('an app mutation just before the edit returns does not count as its render', async () => {
    const c = await open(['li#a', 'li#b', 'li#c'])
    await c.click(pointOf(0))
    c.doc().body.setAttribute('data-clock', '12:00') // the app changes on its own (a clock, a spinner) as the edit goes out
    await c.press('Delete')
    expect(engine.children).toEqual(['li#b', 'li#c'])
    await quiet() // no HMR yet
    await c.click(pointOf(1)) // li#b on the canvas, stamped #0.1: li#c on disk, same name
    await c.press('Delete')
    expect(engine.children).toEqual(['li#b', 'li#c'])
    expect(engine.ops).toHaveLength(1)
  })

  it('a stylesheet hot update landing first does not count as the edit rendering', async () => {
    const c = await open(['li#a', 'li#b', 'li#c'])
    await c.click(pointOf(0))
    await c.press('Delete')
    expect(engine.children).toEqual(['li#b', 'li#c'])
    // Vite applies Tailwind's CSS update in a batch of its own, before the module's.
    const style = c.doc().createElement('style')
    style.textContent = '.gap-2 { gap: 0.5rem }'
    c.doc().head.append(style)
    await quiet()
    await c.click(pointOf(1)) // li#b on the canvas, stamped #0.1: li#c on disk
    await c.press('Delete')
    expect(engine.children).toEqual(['li#b', 'li#c'])
    expect(engine.ops).toHaveLength(1)
    expect(c.view().updating).toBe(true)
  })

  it('a drag that outlives a re-render is refused at the drop', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.grab(pointOf(1), pointOf(0, 'top')) // holding the <button> (#0.1)
    // Another client reorders the file; its HMR lands mid-drag. #0.1 is now the <h2>.
    engine.children = ['p', 'h2', 'button']
    designer.getState().setHistory({ canUndo: true, canRedo: false, undoLabel: 'Edit elsewhere', redoLabel: null })
    c.hmr()
    await quiet()
    c.pointer('pointermove', pointOf(0, 'top'))
    await idle()
    expect(c.view().cursor).toMatchObject({ refused: true })
    c.pointer('pointerup', pointOf(0, 'top'))
    await idle()
    expect(engine.ops).toEqual([])
    expect(engine.children).toEqual(['p', 'h2', 'button'])
  })

  it('a change the canvas has not heard of yet is caught when the DOM contradicts the engine', async () => {
    const c = await open(['h2', 'button', 'p'])
    engine.children = ['button', 'h2', 'p'] // saved in the IDE; no HMR has started
    await c.click(pointOf(0)) // the <h2> on the canvas, #0.0: a <button> on disk now
    await c.press('Delete')
    expect(engine.ops).toEqual([])
    expect(engine.children).toEqual(['button', 'h2', 'p'])
    expect(toasts.some((t) => /<h2>.*<button>/.test(t))).toBe(true)
  })
})

describe('palette drops', () => {
  it('name the node they land on, and wait while the app updates', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.dragTemplateOver(pointOf(2, 'bottom'), BADGE)
    await c.dropTemplate(pointOf(2, 'bottom'), BADGE)
    expect(engine.ops).toEqual([
      { op: 'insert', target: at('0.2'), expectedName: 'p', placement: 'after', snippet: BADGE.snippet, imports: BADGE.imports },
    ])
    expect(engine.children).toEqual(['h2', 'button', 'p', 'Badge'])

    // Before that insert has rendered, the chip says why a drop would be refused.
    await c.dragTemplateOver(pointOf(0, 'top'), BADGE)
    expect(c.view().cursor).toMatchObject({ refused: true, target: expect.stringMatching(/updat/i) })
    await c.dropTemplate(pointOf(0, 'top'), BADGE)
    expect(engine.ops).toHaveLength(1)
  })
})

/** Milliseconds from now until the canvas stops showing itself busy; Infinity if it hasn't within `limit`. */
async function untilSettled(c: ReturnType<typeof mountCanvas>, limit: number): Promise<number> {
  const start = performance.now()
  while (performance.now() - start < limit) {
    if (!c.view().updating) return performance.now() - start
    await tick(10)
  }
  return Infinity
}

describe('a click while the app updates is deferred, not dropped', () => {
  it('selects what is under the pointer once the edit has rendered', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.click(pointOf(2))
    await c.press('Delete') // the <p>: the <h2> above it keeps its place
    expect(engine.children).toEqual(['h2', 'button'])
    expect(c.view().updating).toBe(true)

    await c.click(pointOf(0)) // the <h2>, before HMR has rendered
    expect(designer.getState().selected).toBeNull() // not from the old render
    expect(designer.getState().pressPending).toBe(true)
    c.hmr()
    await quiet()
    expect(designer.getState().selected).toBe(at('0.0'))
    expect(c.view().selection).toMatchObject({ locator: at('0.0'), boxes: [{ y: 10 }] })
    expect(designer.getState().pressPending).toBe(false)
    expect(engine.ops).toHaveLength(1) // a selection, never an edit
  })

  it('waits for an edit that is still on its way, then for its render', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.click(pointOf(2))
    let release = () => {}
    engine.hold = new Promise((resolve) => (release = resolve))
    await c.press('Delete')
    await c.click(pointOf(0))
    expect(designer.getState().selected).toBe(at('0.2'))
    release()
    engine.hold = null
    await idle()
    expect(designer.getState().selected).toBeNull() // the removal's own follow-up: its node is gone…
    expect(designer.getState().pressPending).toBe(true) // …and the click still waits
    expect(c.view().updating).toBe(true)
    c.hmr()
    await quiet()
    expect(designer.getState().selected).toBe(at('0.0'))
  })

  it('selects as soon as the edit it waited for is refused (nothing to render)', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.click(pointOf(2))
    let release = () => {}
    engine.hold = new Promise((resolve) => (release = resolve))
    await c.press('Delete')
    await c.click(pointOf(1))
    engine.children = ['h2', 'button', 'div'] // another writer got there first: the engine answers 409
    release()
    engine.hold = null
    await idle()
    expect(toasts.some((t) => /expected <p>/.test(t))).toBe(true)
    expect(c.view().updating).toBe(false)
    expect(designer.getState().selected).toBe(at('0.1'))
  })

  it('gives way to a selection made meanwhile', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.click(pointOf(2))
    await c.press('Delete')
    await c.click(pointOf(0))
    designer.getState().select(at('0.1')) // e.g. the inspector's breadcrumbs
    c.hmr()
    await quiet()
    expect(designer.getState().selected).toBe(at('0.1'))
  })

  it('is dropped by Escape', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.click(pointOf(2))
    await c.press('Delete')
    await c.click(pointOf(0))
    await c.press('Escape')
    expect(designer.getState().pressPending).toBe(false)
    c.hmr()
    await quiet()
    expect(designer.getState().selected).toBeNull()
  })

  it('a later click replaces it', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.click(pointOf(2))
    await c.press('Delete')
    await c.click(pointOf(0))
    await c.click(pointOf(1))
    c.hmr()
    await quiet()
    expect(designer.getState().selected).toBe(at('0.1'))
  })
})

describe('the canvas is busy for a bounded time after an edit', () => {
  it('FR-TN-05 settles a Next edit after the edited file renders without a Vite resource request', async () => {
    const c = await open(['h2', 'button', 'p'])
    designer.getState().setHealth({ ...designer.getState().health!, host: 'next' })
    await c.click(pointOf(2))
    await c.press('Delete')
    c.doc().body.setAttribute('data-clock', '12:00')
    await quiet()
    expect(c.view().updating).toBe(true)
    c.renderFromSource()
    expect(await untilSettled(c, 600)).toBeLessThan(600)
    expect(engine.children).toEqual(['h2', 'button'])
  })

  it('settles at a deadline when the app never stops changing its DOM', async () => {
    const c = await open(['h2', 'button', 'p'])
    // A ticker: the app changes its DOM every 20 ms (an animation library, a clock).
    const ticker = setInterval(() => c.doc().body.setAttribute('data-tick', String(performance.now())), 20)
    try {
      await c.click(pointOf(2))
      await c.press('Delete')
      const answered = performance.now()
      c.hmr()
      await tick(300)
      expect(c.view().updating).toBe(true) // never quiet: only the deadline ends it
      await c.click(pointOf(0))
      expect(await untilSettled(c, 3000)).toBeLessThan(Infinity)
      expect(performance.now() - answered).toBeLessThan(1000)
      await idle()
      expect(designer.getState().selected).toBe(at('0.0'))
    } finally {
      clearInterval(ticker)
    }
  })

  it('does not settle before the edit’s own hot update has arrived, however much the app changes', async () => {
    const c = await open(['h2', 'button', 'p'])
    const ticker = setInterval(() => c.doc().body.setAttribute('data-tick', String(performance.now())), 20)
    try {
      await c.click(pointOf(2))
      await c.press('Delete')
      await tick(900) // Vite is slow to re-import (it took over a second in a real run)
      expect(c.view().updating).toBe(true) // the DOM can't show the edit yet
      const hot = performance.now()
      c.hmr()
      expect(await untilSettled(c, 3000)).toBeLessThan(Infinity)
      expect(performance.now() - hot).toBeLessThan(1000)
    } finally {
      clearInterval(ticker)
    }
  })

  it('does not take an app change between the answer and the hot update for the edit’s render', async () => {
    const c = await open(['li#a', 'li#b', 'li#c'])
    await c.click(pointOf(0))
    await c.press('Delete')
    expect(engine.children).toEqual(['li#b', 'li#c'])
    c.doc().body.setAttribute('data-clock', '12:01') // the app ticks once, then is quiet
    await quiet()
    await c.click(pointOf(1)) // li#b on the canvas, stamped #0.1: li#c on disk, same name
    await c.press('Delete')
    expect(engine.ops).toHaveLength(1)
    expect(engine.children).toEqual(['li#b', 'li#c'])
    c.hmr()
    await quiet()
    expect(designer.getState().selected).toBe(at('0.1')) // the click, on what the canvas shows now
  })

  it('settles right after the answer when the hot update rendered before it arrived', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.click(pointOf(2))
    let release = () => {}
    engine.delayReply = new Promise((resolve) => (release = resolve))
    await c.press('Delete') // written; the answer is slow
    c.hotUpdate('src/Page.tsx') // Vite re-imported the module…
    c.hmr() // …and React rendered it, before the designer heard back
    await quiet()
    release()
    engine.delayReply = null
    await tick()
    expect(await untilSettled(c, 3000)).toBeLessThan(300)
  })

  it('does not take another file’s hot update for the edit’s render', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.click(pointOf(2))
    let release = () => {}
    engine.delayReply = new Promise((resolve) => (release = resolve))
    await c.press('Delete')
    c.hotUpdate('src/Other.tsx')
    c.doc().body.setAttribute('data-other', 'rendered') // that other module's render
    await quiet()
    release()
    engine.delayReply = null
    await tick(400)
    expect(c.view().updating).toBe(true)
    c.hmr()
    expect(await untilSettled(c, 3000)).toBeLessThan(400)
  })

  it('does not take a hot update requested before the edit was sent for its render', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.click(pointOf(2))
    let release = () => {}
    engine.delayReply = new Promise((resolve) => (release = resolve))
    await c.press('Delete')
    await tick(60)
    c.hotUpdate('src/Page.tsx', 1000) // asked for before the edit went out: an earlier change
    c.doc().body.setAttribute('data-earlier', 'rendered')
    await quiet()
    release()
    engine.delayReply = null
    await tick(400)
    expect(c.view().updating).toBe(true)
  })
})

describe('a full reload while an edit renders (finding 16)', () => {
  it('releases the held selection box and the gesture gate', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.drag(pointOf(1), pointOf(0, 'top')) // the <button> before the <h2>: selection → #0.0
    expect(c.view().selection?.locator).toBe(at('0.1')) // held where the button still is on the canvas

    c.reload() // Vite full-reloads instead of hot-updating
    await quiet()
    expect(designer.getState().selected).toBe(at('0.0'))
    expect(c.view().selection).toMatchObject({ locator: at('0.0'), boxes: [{ y: 10 }] })
    expect(c.view().updating).toBe(false)

    await c.click(pointOf(2))
    expect(designer.getState().selected).toBe(at('0.2'))
    expect(c.view().selection?.locator).toBe(at('0.2'))
  })
})

describe('a Next document catches up once it has hydrated (LLD-13 §6)', () => {
  // An HMR update that reaches a Next document before its React root first commits is lost
  // (React Refresh re-renders only mounted roots). So, once per document, after hydration, the
  // canvas asks the app's router for a fresh render, and stays busy until that has rendered.
  let refreshes: Document[]
  let warn: ReturnType<typeof vi.spyOn>
  const withRouter = (app: AppDocument) => {
    Object.assign(app.win, { next: { router: { refresh: () => refreshes.push(app.doc) } } })
  }

  beforeEach(() => {
    refreshes = []
    reloads.length = 0
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    designer.getState().setHealth({ ...designer.getState().health!, host: 'next' })
    engine.children = ['h2', 'button', 'p']
  })

  afterEach(() => {
    warn.mockRestore()
    vi.useRealTimers()
  })

  it('FR-TN-05 refreshes the router once, after the route announcer appears, and is busy until that renders', async () => {
    const c = (canvas = mountCanvas(engine, true, { prepare: withRouter }))
    await quiet()
    expect(refreshes).toEqual([]) // not hydrated yet: a refresh now could not reach a mounted root
    expect(c.view().updating).toBe(true)

    c.hydrate()
    await idle()
    expect(refreshes).toEqual([c.doc()])
    expect(c.view().updating).toBe(true) // the refresh has not answered

    c.routerAnswered()
    expect(await untilSettled(c, 600)).toBeLessThan(600)
    c.doc().body.setAttribute('data-clock', '12:00') // the app changes later: no second refresh
    await quiet()
    expect(refreshes).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('refreshes once when the document has hydrated before the canvas attached', async () => {
    const c = (canvas = mountCanvas(engine, true, {
      prepare: (app) => {
        withRouter(app)
        app.doc.body.append(app.doc.createElement('next-route-announcer'))
      },
    }))
    await idle()
    expect(refreshes).toEqual([c.doc()])
    c.routerAnswered()
    expect(await untilSettled(c, 600)).toBeLessThan(600)
    expect(refreshes).toHaveLength(1)
  })

  it('refreshes each new document again, and never for a change within the same document', async () => {
    const c = (canvas = mountCanvas(engine, true, { prepare: withRouter }))
    c.hydrate()
    await idle()
    c.routerAnswered()
    await untilSettled(c, 600)
    const first = c.doc()

    // A client-side navigation or a hot update re-renders the same document.
    c.renderFromSource()
    c.doc().querySelector('next-route-announcer')!.textContent = 'Customers'
    await quiet()
    expect(refreshes).toEqual([first])

    c.reload() // a full reload: a new document, hydrating again
    await quiet()
    expect(refreshes).toEqual([first])
    c.hydrate()
    await idle()
    expect(refreshes).toEqual([first, c.doc()])
  })

  it('never refreshes on a Vite host', async () => {
    const { host: _next, ...vite } = designer.getState().health! // Vite's health names no host
    designer.getState().setHealth(vite)
    const c = (canvas = mountCanvas(engine, true, { prepare: withRouter }))
    c.hydrate()
    await quiet()
    expect(refreshes).toEqual([])
    expect(c.view().updating).toBe(false)
  })

  it('warns once and lets the user in when the app has no router to refresh', async () => {
    const c = (canvas = mountCanvas(engine))
    c.hydrate()
    await idle()
    expect(c.view().updating).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/window\.next\.router\.refresh.*16\.4\.6/s)
  })

  it('warns once and lets the user in when the document never hydrates', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const c = (canvas = mountCanvas(engine, true, { prepare: withRouter }))
    await idle()
    expect(c.view().updating).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    await idle()
    expect(c.view().updating).toBe(false)
    expect(refreshes).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/next-route-announcer.*16\.4\.6/s)
  })

  it('warns once and lets the user in when the refresh never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const c = (canvas = mountCanvas(engine, true, { prepare: withRouter }))
    c.hydrate()
    await idle()
    expect(refreshes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    await idle()
    expect(c.view().updating).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a click before the document has loaded waits for it to hydrate and catch up', async () => {
    const c = (canvas = mountCanvas(engine, true, { prepare: withRouter, loaded: false }))
    await idle()
    expect(c.view().updating).toBe(true) // the server-rendered page shows, but the canvas has no document yet
    await c.click(pointOf(1))
    expect(designer.getState().selected).toBeNull()
    expect(designer.getState().pressPending).toBe(true)

    c.load()
    c.hydrate()
    await idle()
    expect(designer.getState().selected).toBeNull() // still catching up
    c.routerAnswered()
    await quiet()
    expect(c.view().updating).toBe(false)
    expect(designer.getState().selected).toBe(at('0.1'))
  })

  it('a press before the document has loaded is dropped when no document comes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const c = (canvas = mountCanvas(engine, true, { prepare: withRouter, loaded: false }))
    await idle()
    await c.click(pointOf(1))
    expect(designer.getState().pressPending).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    await idle()
    expect(c.view().updating).toBe(false)
    expect(designer.getState().pressPending).toBe(false)
    expect(designer.getState().selected).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('an edit the designer has not heard of yet keeps the canvas busy from the catch-up to its own render', async () => {
    // An agent's edit, written before this document loaded; the designer's poll has not seen it.
    engine.apply({ op: 'remove', target: at('0.2'), expectedName: 'p' }, 'Remove element')
    await tick(5)
    const c = (canvas = mountCanvas(engine, true, { prepare: withRouter }))
    c.hydrate()
    await idle() // the catch-up's read is the history sync: it notices the edit
    expect(designer.getState().history.undoLabel).toBe('Remove element #1')
    expect(reloads).toEqual([]) // written before the document began to load
    expect(refreshes).toEqual([c.doc()])
    c.routerAnswered()
    await quiet()
    expect(await untilSettled(c, 3000)).toBeLessThan(Infinity)
    // One busy stretch from the attach to the end: no idle moment a press could fall into.
    const busy = c.views().map((view) => view.updating)
    expect(busy.slice(busy.indexOf(true), -1).every(Boolean)).toBe(true)
    expect(busy.at(-1)).toBe(false)
  })

  it('reloads, instead of refreshing, a document the service wrote to while it loaded', async () => {
    const c = (canvas = mountCanvas(engine, true, { prepare: withRouter }))
    engine.apply({ op: 'remove', target: at('0.2'), expectedName: 'p' }, 'Remove element') // an agent, just now
    c.hydrate()
    await idle()
    expect(reloads).toEqual([]) // not before Next can have compiled the write (COMPILE_GRACE_MS)
    expect(c.view().updating).toBe(true)
    await tick(550)
    expect(reloads).toEqual([c.doc().defaultView])
    expect(refreshes).toEqual([])
    expect(c.view().updating).toBe(true)
  })

  it('a click while the document catches up selects on the caught-up render', async () => {
    const c = (canvas = mountCanvas(engine, true, { prepare: withRouter }))
    c.hydrate()
    await idle()
    await c.click(pointOf(2)) // the <p> of the stale render, before the refresh rendered
    expect(designer.getState().selected).toBeNull()
    expect(designer.getState().pressPending).toBe(true)

    engine.children = ['button', 'p'] // an edit the hydrating document missed…
    c.routerAnswered()
    c.renderFromSource() // …which the refresh renders: nothing is at that spot any more
    await quiet()
    expect(c.view().updating).toBe(false)
    expect(designer.getState().pressPending).toBe(false)
    expect(designer.getState().selected).toBeNull() // not at('0.2'), the stale render's <p>
    expect(engine.ops).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------
// Navigation. The frame's browsing context, reduced to the rule of browsers that matters here: a
// load runs from `location.assign` until it arrives, and a reload started meanwhile cancels it
// and reloads the URL the frame is leaving. Vite's client reloads 20 ms after the server sends
// `full-reload`, and an eject's writes make it send one at once (Tailwind's module for a file
// the eject writes again, left without importers by an earlier undo) and more on the watcher's
// events (the lock invalidates the blueprint previews): the designer's navigation to the
// ejected route, sent a moment later, was cancelled in 9 of 10 back-to-back e2e runs.

interface Load {
  url: string
  type: 'navigate' | 'reload'
}

function mountFrame(engine: FakeEngine, path: string) {
  const origin = 'http://localhost:5173'
  /** Every URL the canvas asked the frame to load, in order. */
  const requested: string[] = []
  let pending: Load | null = null

  /** One document: a real jsdom window, with the URL and navigation entry of `load`. */
  function open(load: Load) {
    const app = appDocument()
    render(app, engine.children)
    let url = load.url
    const location = {
      get href() { return url },
      get origin() { return origin },
      get pathname() { return new URL(url).pathname },
      get search() { return new URL(url).search },
      get hash() { return new URL(url).hash },
      assign(to: string) {
        requested.push(to)
        const next = new URL(to, url)
        // Only the hash changes: the document scrolls, nothing loads.
        if (next.hash !== '' && next.href.split('#')[0] === url.split('#')[0]) url = next.href
        else pending = { url: next.href, type: 'navigate' }
      },
    }
    const performance = {
      timeOrigin: app.win.performance.timeOrigin,
      now: () => app.win.performance.now(),
      getEntriesByType: (type: string) => (type === 'navigation' ? [{ name: load.url, type: load.type }] : []),
    }
    const win = new Proxy(app.win, {
      get(target, key) {
        if (key === 'location') return location
        if (key === 'performance') return performance
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { app, win, pushState: (to: string) => { url = new URL(to, url).href } }
  }

  let shown = open({ url: origin + path, type: 'navigate' })
  const iframe = document.createElement('iframe')
  Object.defineProperty(iframe, 'contentWindow', { get: () => shown.win })
  Object.defineProperty(iframe, 'contentDocument', { get: () => shown.app.doc })
  Object.defineProperty(iframe, 'offsetWidth', { get: () => 800 })
  iframe.getBoundingClientRect = () => rect(0, 0, 800, 600)
  const overlay = document.createElement('div')
  document.body.append(overlay)
  const controller = new CanvasController(iframe, overlay, () => {})
  const unmount = controller.mount()
  iframe.dispatchEvent(new Event('load'))

  return {
    controller,
    requested,
    /** Vite's client: `location.reload()`, which cancels a load on its way. */
    reload() {
      pending = { url: shown.win.location.href, type: 'reload' }
    },
    /** A link in the app: the frame starts a load the canvas didn't ask for. */
    follow(to: string) {
      pending = { url: new URL(to, origin).href, type: 'navigate' }
    },
    /** The app's router moves within the document (`history.pushState`). */
    pushState: (to: string) => shown.pushState(to),
    /** The load on its way arrives: the old document goes, the new one renders and loads. */
    async arrive() {
      const load = pending
      if (!load) throw new Error('no load is on its way')
      pending = null
      shown.app.win.dispatchEvent(new Event('pagehide'))
      shown = open(load)
      iframe.dispatchEvent(new Event('load'))
      await idle()
    },
    /** The path of the load on its way, if any. */
    get loading() {
      return pending ? pending.url.slice(origin.length) : null
    },
    unmount() {
      unmount()
      overlay.remove()
    },
  }
}

describe('a navigation the canvas asks for', () => {
  let frame: ReturnType<typeof mountFrame> | null = null
  afterEach(() => {
    frame?.unmount()
    frame = null
  })

  async function openAt(path: string) {
    engine.children = ['button']
    frame = mountFrame(engine, path)
    await idle()
    return frame
  }

  it('is asked for again when a reload cancels it, and arrives', async () => {
    const f = await openAt('/__blueprint/AccountIntake')
    f.controller.api.navigate('/blueprint-account-intake')
    f.reload() // the eject's full reload lands while the ejected route loads
    await f.arrive() // the preview again, reloaded

    expect(f.requested).toEqual(['/blueprint-account-intake', '/blueprint-account-intake'])
    expect(f.loading).toBe('/blueprint-account-intake')
    await f.arrive()
    expect(designer.getState().canvasPath).toBe('/blueprint-account-intake')
  })

  it('is asked for again after each reload that cancels it', async () => {
    const f = await openAt('/__blueprint/AccountIntake')
    f.controller.api.navigate('/blueprint-account-intake')
    f.reload()
    await f.arrive()
    f.reload() // a second full reload reaches the reloaded preview
    await f.arrive()
    await f.arrive()

    expect(f.requested).toEqual(Array(3).fill('/blueprint-account-intake'))
    expect(designer.getState().canvasPath).toBe('/blueprint-account-intake')
  })

  it('is not asked for again once it has arrived', async () => {
    const f = await openAt('/__blueprint/AccountIntake')
    f.controller.api.navigate('/blueprint-account-intake')
    await f.arrive()
    f.reload()
    await f.arrive()

    expect(f.requested).toEqual(['/blueprint-account-intake'])
    expect(f.loading).toBeNull()
    expect(designer.getState().canvasPath).toBe('/blueprint-account-intake')
  })

  it('gives way to a load the app started meanwhile', async () => {
    const f = await openAt('/__blueprint/AccountIntake')
    f.controller.api.navigate('/blueprint-account-intake')
    f.follow('/customers')
    await f.arrive()
    f.reload()
    await f.arrive()

    expect(f.requested).toEqual(['/blueprint-account-intake'])
    expect(designer.getState().canvasPath).toBe('/customers')
  })

  it('to a new hash loads nothing, so no later reload repeats it', async () => {
    const f = await openAt('/customers')
    f.controller.api.navigate('#details')
    f.pushState('/orders')
    f.reload()
    await f.arrive()

    expect(f.requested).toEqual(['#details'])
    expect(designer.getState().canvasPath).toBe('/orders')
  })
})

describe('the right-click menu', () => {
  it('selects the element under the cursor and opens its menu there', async () => {
    const c = await open(['h2', 'button', 'p'])
    expect(await c.rightClick(pointOf(1))).toBe(true)
    expect(designer.getState().selected).toBe(at('0.1'))
    expect(c.view().menu).toMatchObject({ at: pointOf(1), locator: at('0.1'), name: 'button', moveUp: null, moveDown: null, remove: null })
  })

  it('says why an action is unavailable: the ends, the root, and {…} neighbours', async () => {
    engine.indirect.add(2)
    const c = await open(['h2', 'button', 'p', 'span'])
    await c.rightClick(pointOf(0))
    expect(c.view().menu).toMatchObject({ moveUp: 'it is already first', moveDown: null })
    await c.rightClick(pointOf(1))
    expect(c.view().menu?.moveDown).toBe('the element after it is rendered from a {…} expression')
    await c.rightClick(pointOf(3))
    expect(c.view().menu).toMatchObject({ moveUp: 'the element before it is rendered from a {…} expression', moveDown: 'it is already last' })
    await c.rightClick(pointOf(2))
    expect(c.view().menu).toMatchObject({ moveUp: 'it is rendered from a {…} expression', remove: 'it is rendered from a {…} expression' })
    await c.rightClick({ x: 300, y: 5 }) // the root <div>, outside every child
    expect(c.view().menu).toMatchObject({ locator: ROOT, moveUp: 'it is the root of Page', remove: 'it is the root of Page' })
  })

  it('moves the element down past its next sibling, guarding both names', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.rightClick(pointOf(0))
    await c.controller.runMenuAction('moveDown')
    await idle()
    expect(engine.ops.at(-1)).toEqual({ op: 'move', source: at('0.0'), expectedName: 'h2', target: at('0.1'), expectedTargetName: 'button', placement: 'after' })
    expect(engine.children).toEqual(['button', 'h2', 'p'])
    expect(c.view().menu).toBeNull()
  })

  it('moves the element up before its previous sibling', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.rightClick(pointOf(2))
    await c.controller.runMenuAction('moveUp')
    await idle()
    expect(engine.ops.at(-1)).toEqual({ op: 'move', source: at('0.2'), expectedName: 'p', target: at('0.1'), expectedTargetName: 'button', placement: 'before' })
    expect(engine.children).toEqual(['h2', 'p', 'button'])
  })

  it('deletes the element and selects its parent, as Delete and ↑ do', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.rightClick(pointOf(1))
    await c.controller.runMenuAction('selectParent')
    await idle()
    expect(designer.getState().selected).toBe(ROOT)
    await c.rightClick(pointOf(1))
    await c.controller.runMenuAction('remove')
    await idle()
    expect(engine.ops.at(-1)).toEqual({ op: 'remove', target: at('0.1'), expectedName: 'button' })
    expect(engine.children).toEqual(['h2', 'p'])
  })

  it('does not run an unavailable action', async () => {
    const c = await open(['h2', 'button'])
    await c.rightClick(pointOf(0))
    await c.controller.runMenuAction('moveUp')
    await idle()
    expect(engine.ops).toEqual([])
  })

  it('opens nothing on empty canvas, but still keeps the browser menu away', async () => {
    const c = await open(['h2', 'button'])
    await c.click(pointOf(0))
    expect(await c.rightClick({ x: 600, y: 500 })).toBe(true)
    expect(c.view().menu).toBeNull()
    expect(designer.getState().selected).toBe(at('0.0'))
  })

  it('leaves the browser menu to the app in interact mode', async () => {
    const c = await open(['h2', 'button'])
    designer.getState().setMode('interact')
    expect(await c.rightClick(pointOf(0))).toBe(false)
    expect(c.view().menu).toBeNull()
  })

  it('opens nothing while an edit renders', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.drag(pointOf(1), pointOf(0, 'top'))
    expect(c.view().updating).toBe(true)
    expect(await c.rightClick(pointOf(2))).toBe(true)
    expect(c.view().menu).toBeNull()
  })

  it('closes when the app re-renders, so a stale menu never acts', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.rightClick(pointOf(1))
    expect(c.view().menu).not.toBeNull()
    engine.children = ['p', 'h2', 'button'] // an edit from elsewhere
    c.hmr()
    await quiet()
    expect(c.view().menu).toBeNull()
    await c.controller.runMenuAction('remove')
    await idle()
    expect(engine.ops).toEqual([])
  })

  it('closes on Escape (the menu reports it) and when the selection moves on', async () => {
    const c = await open(['h2', 'button', 'p'])
    await c.rightClick(pointOf(1))
    c.controller.closeMenu()
    await idle()
    expect(c.view().menu).toBeNull()
    await c.rightClick(pointOf(1))
    await c.click(pointOf(2))
    expect(c.view().menu).toBeNull()
  })
})

