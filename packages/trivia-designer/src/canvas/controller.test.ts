// @vitest-environment jsdom
//
// The canvas controller against the real FrameSession, store and action bus; the engine is a
// fetch stub with positional locators and expected-name guards (mutator.rs), and the app's
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

import { engine as client } from '@/bridge/client'
import type { ApplyResult, HistoryState, NodeDetails, Op, Placement } from '@/bridge/types'
import { type CanvasView, CanvasController, EMPTY_VIEW, TEMPLATE_MIME } from '@/canvas/controller'
import type { Template } from '@/registry/templates'
import { designer } from '@/state/store'

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
      isDirect: true,
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
    const history: HistoryState = { canUndo: true, canRedo: false, undoLabel: `${label} #${++this.entries}`, redoLabel: null }
    return { file: FILE, changed: true, locator: placed === null ? null : at(`0.${placed}`), history }
  }

  /** mutator.rs `resolve_expected`: a locator that now names another element is a 409. */
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
      if (path === '/apply') {
        const { op, label } = JSON.parse(String(init?.body)) as { op: Op; label: string }
        await engine.hold
        return reply({ ok: true, data: engine.apply(op, label) })
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
  Object.assign(win, {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    PerformanceObserver: class {
      observe() {}
      disconnect() {}
    },
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
  return { win, doc }
}

/** What the locator plugin and React would render for `children`. */
function render(app: AppDocument, children: readonly string[]): void {
  const rows = children.map((child, i) => {
    const tag = nameOf(child)
    return `<${tag} data-ast-node="${at(`0.${i}`)}" data-rect="10,${10 + ROW * i},200,20">${child}</${tag}>`
  })
  app.doc.body.innerHTML = `<div data-ast-node="${ROOT}" data-rect="0,0,400,${20 + ROW * children.length}">${rows.join('')}</div>`
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

function mountCanvas(engine: FakeEngine) {
  let app = appDocument()
  render(app, engine.children)
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
  iframe.dispatchEvent(new Event('load'))

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
    doc: () => app.doc,
    /** HMR: React re-renders the app from the source as it is now. */
    hmr: () => render(app, engine.children),
    /** Vite reloads the page instead: a new document renders the source as it is now. */
    reload: () => {
      app.win.dispatchEvent(new Event('pagehide'))
      app = appDocument()
      render(app, engine.children)
      iframe.dispatchEvent(new Event('load'))
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
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
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
