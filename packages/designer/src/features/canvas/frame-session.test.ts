// @vitest-environment jsdom
//
// A Next document's catch-up (LLD-13 §6), against FrameSession itself: the canvas listener is a
// stub that answers `lastWrite`, the app's documents are jsdom iframes, and reloading one is
// what the test does when `reloadDocument` is called.
//
// One fake clock drives everything the catch-up reads: timers, Date (the service's lastWriteAt),
// the designer's performance, and each frame document's timeOrigin and performance.now(). No
// real time passes, so each test asserts its deadline to the millisecond.

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
  resources: Array<(list: { getEntries(): Array<{ name: string; startTime: number; responseEnd: number; duration: number }> }) => void>
}

/** A new app document, which began to load now (on the fake clock). */
function appDocument(): App {
  const host = document.createElement('iframe')
  document.body.append(host)
  const win = host.contentWindow as FrameWindow
  const app: App = { win, doc: host.contentDocument!, refreshes: 0, resources: [] }
  const timeOrigin = Date.now()
  Object.defineProperty(win, 'performance', { configurable: true, value: { timeOrigin, now: () => Date.now() - timeOrigin } })
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

/** Let `ms` pass on the fake clock, running the timers and promises due meanwhile. */
const later = (ms: number) => vi.advanceTimersByTimeAsync(ms)

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
/** The current document's navigation start, as the window test reads it. */
const began = () => app.win.performance.timeOrigin
/** The router's request for the refresh answered, as the frame's resource timing reports it. */
function routerAnswered(): void {
  const now = app.win.performance.now()
  const entry = { name: `${app.win.location.href}?_rsc=1`, startTime: now, responseEnd: now, duration: 0 }
  for (const observer of [...app.resources]) observer({ getEntries: () => [entry] })
}
/** The page reloads: its document unloads, a new one loads. */
function reload(): void {
  app.win.dispatchEvent(new Event('pagehide'))
  app = appDocument()
  iframe.dispatchEvent(new Event('load'))
}
/** The refresh answers and the DOM stays quiet: the catch-up ends QUIET_MS (120 ms) later. */
async function settle(): Promise<void> {
  routerAnswered()
  await later(119)
  expect(session.updating).toBe(true)
  await later(1)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], now: 1_795_000_000_000 })
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
  it('reloads once, exactly the grace after the write, and is busy throughout', async () => {
    startSession()
    await later(100) // the document loads
    lastWrite = async () => Date.now() - 10 // an agent's edit, written while it loaded
    hydrate()
    await later(0)
    expect(app.refreshes).toBe(0)
    await later(489)
    expect(reloads.windows).toEqual([]) // Turbopack may not have seen the write yet
    expect(session.updating).toBe(true)
    await later(1)
    expect(reloads.windows).toEqual([app.win])

    reload()
    expect(session.updating).toBe(true) // between the unload and the new attach as well
    lastWrite = async () => began() - 501 // nothing since: the write was before the grace
    hydrate()
    await later(0)
    expect(app.refreshes).toBe(1)
    expect(reloads.windows).toHaveLength(1)
    await settle()
    expect(session.updating).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('reloads at once when the write was the grace or more ago', async () => {
    startSession()
    await later(560) // the document took its time to hydrate
    lastWrite = async () => Date.now() - 500
    hydrate()
    await later(0)
    expect(reloads.windows).toEqual([app.win])
  })

  it('waits exactly the grace when the write seems to be in the future (a skewed clock)', async () => {
    startSession()
    lastWrite = async () => Date.now() + 5_000
    hydrate()
    await later(499)
    expect(reloads.windows).toEqual([])
    await later(1)
    expect(reloads.windows).toHaveLength(1)
  })

  it('does not reload a document that unloads, or a session that stops, during the grace', async () => {
    startSession()
    lastWrite = async () => Date.now()
    hydrate()
    await later(100)
    app.win.dispatchEvent(new Event('pagehide')) // the user navigated away meanwhile
    await later(600)
    expect(reloads.windows).toEqual([])

    app = appDocument()
    iframe.dispatchEvent(new Event('load'))
    hydrate()
    await later(100)
    stop()
    await later(600)
    expect(reloads.windows).toEqual([])
  })

  it('reloads a reloaded document once more when the write came within the grace before it began', async () => {
    startSession()
    lastWrite = async () => Date.now()
    hydrate()
    await later(500)
    expect(reloads.windows).toHaveLength(1)
    reload()
    lastWrite = async () => began() - 100 // the reload came too soon after the write after all
    hydrate()
    await later(399) // delayed the same way: the grace after the write
    expect(reloads.windows).toHaveLength(1)
    await later(1)
    expect(reloads.windows).toHaveLength(2)
    expect(app.refreshes).toBe(0)
  })

  it('counts a write exactly the grace before a reloaded document began, and refreshes for one a millisecond older', async () => {
    startSession()
    lastWrite = async () => Date.now()
    hydrate()
    await later(500)
    reload()
    lastWrite = async () => began() - 500 // the edge of its window: reload, the grace long past
    hydrate()
    await later(0)
    expect(reloads.windows).toHaveLength(2)

    reload() // the chain's second reload
    lastWrite = async () => null
    hydrate()
    await later(0)
    await settle()
    reload() // the user's own reload: a new chain
    lastWrite = async () => Date.now()
    hydrate()
    await later(500)
    expect(reloads.windows).toHaveLength(3)
    reload()
    lastWrite = async () => began() - 501
    hydrate()
    await later(0)
    expect(reloads.windows).toHaveLength(3)
    expect(app.refreshes).toBe(1)
  })

  it('reloads at most twice in a chain, then refreshes with one warning', async () => {
    startSession()
    lastWrite = async () => Date.now() // something keeps writing
    for (let reloaded = 1; reloaded <= 2; reloaded++) {
      hydrate()
      await later(500)
      expect(reloads.windows).toHaveLength(reloaded)
      reload()
    }
    hydrate()
    await later(500)
    expect(reloads.windows).toHaveLength(2)
    expect(app.refreshes).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/wrote the Next\.js app again.*2 times.*16\.4\.6/s)
    await settle()
    expect(session.updating).toBe(false)
  })

  it('refreshes a first document whose last write came a millisecond before it began, or that has none', async () => {
    startSession()
    lastWrite = async () => began() - 1 // no grace for a document the user or Next loaded
    hydrate()
    await later(0)
    expect(reloads.windows).toEqual([])
    expect(app.refreshes).toBe(1)
    await settle()

    reload() // a full reload of its own: not a catch-up
    lastWrite = async () => null
    hydrate()
    await later(0)
    expect(reloads.windows).toEqual([])
    expect(app.refreshes).toBe(1)
  })

  it('refreshes, without reloading, when the read fails or takes a second', async () => {
    startSession()
    lastWrite = () => Promise.reject(new Error('the engine went away'))
    hydrate()
    await later(0)
    expect(app.refreshes).toBe(1)
    await settle()
    expect(session.updating).toBe(false)

    reload()
    lastWrite = () => new Promise(() => {}) // never answers
    hydrate()
    await later(999)
    expect(app.refreshes).toBe(0)
    await later(1)
    expect(app.refreshes).toBe(1)
    expect(reloads.windows).toEqual([])
    await settle()
    expect(session.updating).toBe(false)
  })

  it('starts a new chain after a document that caught up without reloading', async () => {
    startSession()
    lastWrite = async () => Date.now()
    hydrate()
    await later(500)
    reload() // the catch-up reload
    lastWrite = async () => null
    hydrate()
    await later(0)
    await settle()

    lastWrite = async () => Date.now() // later, edits while the user reloads, twice over
    for (let reloaded = 2; reloaded <= 3; reloaded++) {
      reload()
      hydrate()
      await later(500)
      expect(reloads.windows).toHaveLength(reloaded)
    }
  })

  it('never reads or reloads on a Vite host', async () => {
    const read = vi.fn(async () => Date.now())
    lastWrite = read
    startSession(false)
    hydrate()
    await later(600)
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
    await later(0)
    await settle()
    expect(session.updating).toBe(false)

    app.win.dispatchEvent(new Event('pagehide'))
    expect(session.updating).toBe(true)
    app = appDocument()
    iframe.dispatchEvent(new Event('load'))
    expect(session.updating).toBe(true) // now catching up
  })

  it('for ten seconds at most, then lets go without a warning', async () => {
    startSession(true, false)
    await later(9_999)
    expect(session.updating).toBe(true)
    expect(listener.loadTimedOut).not.toHaveBeenCalled()
    await later(1)
    expect(session.updating).toBe(false)
    expect(listener.loadTimedOut).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('never on a Vite host', () => {
    startSession(false, false)
    expect(session.updating).toBe(false)
  })
})
