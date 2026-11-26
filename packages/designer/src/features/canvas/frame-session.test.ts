// @vitest-environment jsdom
//
// A Next document's catch-up (LLD-13 §6), against FrameSession itself: the canvas listener is a
// stub that answers `lastWrite`, the app's documents are jsdom iframes, and reloading one is
// what the test does when `reloadDocument` is called.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reloads = vi.hoisted(() => ({ windows: [] as Window[] }))
vi.mock('./next-hydration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./next-hydration')>()),
  reloadDocument: (win: Window) => {
    reloads.windows.push(win)
  },
}))

import { FrameSession } from './frame-session'

type FrameWindow = Window & typeof globalThis
interface App {
  win: FrameWindow
  doc: Document
  refreshes: number
  resources: Array<(list: { getEntries(): Array<{ name: string; startTime: number; responseEnd: number }> }) => void>
}

function appDocument(): App {
  const host = document.createElement('iframe')
  document.body.append(host)
  const win = host.contentWindow as FrameWindow
  const app: App = { win, doc: host.contentDocument!, refreshes: 0, resources: [] }
  Object.assign(win, {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    PerformanceObserver: class {
      private readonly callback: App['resources'][number]
      constructor(callback: App['resources'][number]) {
        this.callback = callback
      }
      observe() {
        app.resources.push(this.callback)
      }
      disconnect() {}
    },
    next: { router: { refresh: () => app.refreshes++ } },
  })
  app.doc.body.innerHTML = '<main data-ast-node="app/page.tsx#Home#0"></main>'
  return app
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

let warn: ReturnType<typeof vi.spyOn>
let lastWrite: () => Promise<number | null>
let session: FrameSession
let stop: () => void
let app: App
let iframe: HTMLIFrameElement
const listener = { attached: vi.fn(), layout: vi.fn(), settled: vi.fn(), loadTimedOut: vi.fn(), lastWrite: () => lastWrite() }

function startSession(next = true, attach = true): void {
  app = appDocument()
  iframe = document.createElement('iframe')
  Object.defineProperty(iframe, 'contentWindow', { get: () => app.win })
  Object.defineProperty(iframe, 'contentDocument', { get: () => app.doc })
  session = new FrameSession(iframe, listener, () => !next, () => next)
  stop = session.start()
  if (attach) iframe.dispatchEvent(new Event('load'))
}

const hydrate = () => app.doc.body.append(app.doc.createElement('next-route-announcer'))
/** The router's request for the refresh answered, as the frame's resource timing reports it. */
function routerAnswered(): void {
  const now = app.win.performance.now()
  for (const observer of [...app.resources]) observer({ getEntries: () => [{ name: `${app.win.location.href}?_rsc=1`, startTime: now, responseEnd: now }] })
}
/** The page reloads: its document unloads, a new one loads. */
async function reload(): Promise<void> {
  app.win.dispatchEvent(new Event('pagehide'))
  await tick(20)
  app = appDocument()
  iframe.dispatchEvent(new Event('load'))
}
async function settle(): Promise<void> {
  routerAnswered()
  await tick(250)
}

beforeEach(() => {
  reloads.windows.length = 0
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  lastWrite = async () => null
  for (const fn of Object.values(listener)) if (vi.isMockFunction(fn)) fn.mockClear()
})

afterEach(() => {
  stop?.()
  warn.mockRestore()
  vi.useRealTimers()
})

describe('a Next document catches up by reloading when the service wrote while it loaded', () => {
  it('reloads once instead of refreshing, and is busy until the reloaded document has caught up', async () => {
    startSession()
    lastWrite = async () => Date.now() // an agent's edit, written while this document loaded
    hydrate()
    await tick()
    expect(reloads.windows).toEqual([app.win])
    expect(app.refreshes).toBe(0)
    expect(session.updating).toBe(true)

    await reload()
    expect(session.updating).toBe(true) // between the unload and the new attach as well
    lastWrite = async () => Date.now() - 60_000 // nothing since
    hydrate()
    await tick()
    expect(app.refreshes).toBe(1)
    expect(reloads.windows).toHaveLength(1)
    expect(session.updating).toBe(true)
    await settle()
    expect(session.updating).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('refreshes the reloaded document, with one warning, when the service wrote again while it loaded', async () => {
    startSession()
    lastWrite = async () => Date.now()
    hydrate()
    await tick()
    await reload()
    hydrate() // still being written: no second reload
    await tick()
    expect(reloads.windows).toHaveLength(1)
    expect(app.refreshes).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/wrote the Next\.js app again.*16\.4\.6/s)
    await settle()
    expect(session.updating).toBe(false)
  })

  it('refreshes when the last write came before the document began to load, or there was none', async () => {
    startSession()
    lastWrite = async () => Math.floor(app.win.performance.timeOrigin) - 1
    hydrate()
    await tick()
    expect(reloads.windows).toEqual([])
    expect(app.refreshes).toBe(1)
    await settle()

    await reload() // a full reload of its own (Next's, or the user's): not a catch-up
    lastWrite = async () => null
    hydrate()
    await tick()
    expect(reloads.windows).toEqual([])
    expect(app.refreshes).toBe(1)
  })

  it('refreshes, without reloading, when the read fails or takes over a second', async () => {
    startSession()
    lastWrite = () => Promise.reject(new Error('the engine went away'))
    hydrate()
    await tick()
    expect(app.refreshes).toBe(1)
    await settle()
    expect(session.updating).toBe(false)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    await reload()
    lastWrite = () => new Promise(() => {}) // never answers
    hydrate()
    await vi.advanceTimersByTimeAsync(900)
    expect(app.refreshes).toBe(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(app.refreshes).toBe(1)
    expect(reloads.windows).toEqual([])
    vi.useRealTimers()
    await settle()
    expect(session.updating).toBe(false)
  })

  it('may reload a later document again once one has caught up without reloading', async () => {
    startSession()
    lastWrite = async () => Date.now()
    hydrate()
    await tick()
    await reload() // the catch-up reload
    lastWrite = async () => null
    hydrate()
    await tick()
    await settle()

    await reload() // the user's reload, later
    lastWrite = async () => Date.now() // and an edit while it loads
    hydrate()
    await tick()
    expect(reloads.windows).toHaveLength(2)
  })

  it('never reads or reloads on a Vite host', async () => {
    const read = vi.fn(async () => Date.now())
    lastWrite = read
    startSession(false)
    hydrate()
    await tick(50)
    expect(read).not.toHaveBeenCalled()
    expect(reloads.windows).toEqual([])
    expect(app.refreshes).toBe(0)
    expect(session.updating).toBe(false)
  })
})

describe('a Next canvas is busy until a document has attached', () => {
  it('from the start and from an unload until the next attach', async () => {
    startSession(true, false)
    expect(session.updating).toBe(true) // the server's HTML may show already; nothing is attached
    iframe.dispatchEvent(new Event('load'))
    hydrate()
    await tick()
    await settle()
    expect(session.updating).toBe(false)

    app.win.dispatchEvent(new Event('pagehide'))
    expect(session.updating).toBe(true)
    app = appDocument()
    iframe.dispatchEvent(new Event('load'))
    expect(session.updating).toBe(true) // now catching up
  })

  it('for at most ten seconds, then lets go without a warning', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    startSession(true, false)
    await vi.advanceTimersByTimeAsync(9_900)
    expect(session.updating).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(session.updating).toBe(false)
    expect(listener.loadTimedOut).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('never on a Vite host', () => {
    startSession(false, false)
    expect(session.updating).toBe(false)
  })
})
