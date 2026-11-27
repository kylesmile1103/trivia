// @vitest-environment jsdom
//
// A Next or Vite document's catch-up (LLD-13 §6), against FrameSession itself: the canvas
// listener is a stub that answers `lastWrite`, the app's documents are jsdom iframes, and
// reloading one is what the test does when `reloadDocument` is called. Each document carries
// the Vite plugin's HMR probe as `probe` says (Next's catch-up ignores it).
//
// One fake clock drives everything the catch-up reads: timers, Date (the service's lastWriteAt),
// the designer's performance, and each frame document's timeOrigin and performance.now(). No
// real time passes, so each test asserts its deadline to the millisecond.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reloads = vi.hoisted(() => ({ windows: [] as Window[] }))
vi.mock('./reload-document', () => ({
  reloadDocument: (win: Window) => {
    reloads.windows.push(win)
  },
}))

import { FrameSession, NEXT_CATCH_UP, VITE_CATCH_UP } from './frame-session'

type FrameWindow = Window & typeof globalThis
type ProbeWindow = FrameWindow & { __TRIVIA_HMR__?: { ready: boolean } }
interface App {
  win: ProbeWindow
  doc: Document
  refreshes: number
  resources: Array<(list: { getEntries(): Array<{ name: string; startTime: number; responseEnd: number; duration: number }> }) => void>
}

/**
 * The Vite plugin's probe in the documents to come: run and already answered by the page's HMR
 * socket (`answered`), run and waiting for the answer (`pending`, until `connect()`), or not on
 * the page (`none`).
 */
let probe: 'answered' | 'pending' | 'none'

/** A new app document, which began to load now (on the fake clock). */
function appDocument(): App {
  const host = document.createElement('iframe')
  document.body.append(host)
  const win = host.contentWindow as ProbeWindow
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
  if (probe !== 'none') win.__TRIVIA_HMR__ = { ready: probe === 'answered' }
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
  session = new FrameSession(iframe, listener, () => !next, () => (next ? NEXT_CATCH_UP : VITE_CATCH_UP))
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
  unloadAndBegin()
  load()
}
/** The document unloads and the next one begins to load (it attaches on `load()`). */
function unloadAndBegin(): void {
  app.win.dispatchEvent(new Event('pagehide'))
  app = appDocument()
}
/** The current document fired `load`: its static modules have run. */
const load = () => iframe.dispatchEvent(new Event('load'))
/** The page's HMR socket answers the probe, which marks itself ready and says so on its window. */
function connect(target: App = app): void {
  target.win.__TRIVIA_HMR__!.ready = true
  target.win.dispatchEvent(new target.win.Event('trivia:hmr-ready'))
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
  probe = 'answered'
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

  it('on a Vite host reads once the page has loaded and its HMR socket answered, and reloads with no grace', async () => {
    const writtenAt = Date.now()
    const read = vi.fn(async () => writtenAt) // written as the document began to load
    lastWrite = read
    startSession(false) // loaded, and the plugin's probe had its answer already
    expect(read).toHaveBeenCalledTimes(1)
    await later(0)
    expect(reloads.windows).toEqual([app.win]) // with the answer, not a grace later
    expect(app.refreshes).toBe(0)
    hydrate() // means nothing on Vite
    await later(600)
    expect(read).toHaveBeenCalledTimes(1)
    expect(reloads.windows).toHaveLength(1)
    expect(app.refreshes).toBe(0)
    expect(session.updating).toBe(true) // until the reload's document has caught up
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

  it('on a Vite host too, from the start and from an unload until the next attach, ten seconds at most', async () => {
    startSession(false, false)
    expect(session.updating).toBe(true) // the page may still be running its modules
    load()
    expect(session.updating).toBe(true) // reading when the service last wrote
    await later(0)
    expect(session.updating).toBe(false)
    expect(listener.settled).toHaveBeenCalledTimes(1)

    app.win.dispatchEvent(new Event('pagehide'))
    expect(session.updating).toBe(true)
    await later(9_999)
    expect(session.updating).toBe(true)
    expect(listener.loadTimedOut).not.toHaveBeenCalled()
    await later(1)
    expect(session.updating).toBe(false)
    expect(listener.loadTimedOut).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('a Vite document catches up once it has loaded and its HMR socket has answered', () => {
  // Vite 8.3.3 drops an update sent before the page's HMR socket connected, and one for a module
  // that has not run yet (vite-hmr.ts). The session attaches on `load` (the static modules have
  // run) and waits for the plugin's probe; a write since the document began then reloads it.

  it('reloads once for a write at its start, the moment the read answers, and is busy throughout', async () => {
    const writtenAt = Date.now()
    lastWrite = async () => writtenAt // an agent's edit, as the document began to load
    startSession(false)
    expect(session.updating).toBe(true)
    await later(0)
    expect(reloads.windows).toEqual([app.win])
    await later(300) // the reload takes its time to unload the page
    expect(session.updating).toBe(true)

    unloadAndBegin()
    expect(session.updating).toBe(true) // between the unload and the new attach as well
    await later(200)
    load() // began 300 ms after the write: it has the written files
    await later(0)
    expect(reloads.windows).toHaveLength(1)
    expect(app.refreshes).toBe(0)
    expect(session.updating).toBe(false)
    expect(listener.settled).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('reads only once its HMR socket has answered, and catches a write made while it connected', async () => {
    probe = 'pending'
    let writtenAt: number | null = null
    const read = vi.fn(async () => writtenAt)
    lastWrite = read
    startSession(false)
    await later(200)
    writtenAt = Date.now() // loaded, but its socket still connecting: the update went to no one
    await later(100)
    expect(read).not.toHaveBeenCalled()
    expect(session.updating).toBe(true)
    connect()
    expect(read).toHaveBeenCalledTimes(1)
    await later(0)
    expect(reloads.windows).toEqual([app.win])
  })

  it('ends without a reload or a refresh when the last write came a millisecond before it began, or there is none', async () => {
    lastWrite = async () => began() - 1
    startSession(false)
    await later(0)
    expect(reloads.windows).toEqual([])
    expect(app.refreshes).toBe(0)
    expect(session.updating).toBe(false)
    expect(listener.settled).toHaveBeenCalledTimes(1)

    await later(100)
    lastWrite = async () => null
    reload() // the user's own reload
    await later(0)
    expect(reloads.windows).toEqual([])
    expect(app.refreshes).toBe(0)
    expect(listener.settled).toHaveBeenCalledTimes(2)
    await later(10_000) // nothing is left to fire
    expect(listener.settled).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalled()
  })

  it('reloads a reloaded document only for a write at or after its own start: no grace before it either', async () => {
    const writtenAt = Date.now()
    lastWrite = async () => writtenAt
    startSession(false)
    await later(0)
    expect(reloads.windows).toHaveLength(1)
    await later(1)
    reload() // began a millisecond after the write (Next would count it: its grace reaches 500 ms back)
    await later(0)
    expect(reloads.windows).toHaveLength(1)
    expect(session.updating).toBe(false)

    await later(100)
    lastWrite = async () => Date.now()
    reload() // the user's own reload, with a write at its start: a new chain
    await later(0)
    expect(reloads.windows).toHaveLength(2)
    await later(100)
    lastWrite = async () => began() // the chain's reload: a write exactly at its start counts
    reload()
    await later(0)
    expect(reloads.windows).toHaveLength(3)
  })

  it('reloads at most twice in a chain, then warns once and lets the user in', async () => {
    lastWrite = async () => Date.now() // something keeps writing
    startSession(false)
    for (let reloaded = 1; reloaded <= 2; reloaded++) {
      await later(0)
      expect(reloads.windows).toHaveLength(reloaded)
      await later(100)
      reload()
    }
    await later(0)
    expect(reloads.windows).toHaveLength(2)
    expect(app.refreshes).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/wrote the Vite app again.*2 times/s)
    expect(session.updating).toBe(false)
    expect(listener.settled).toHaveBeenCalledTimes(1)

    await later(100)
    reload() // the user's own reload: a new chain
    await later(0)
    expect(reloads.windows).toHaveLength(3)
  })

  it('reads at once on a page without the probe, and warns once for the session', async () => {
    probe = 'none'
    const read = vi.fn(async () => null)
    lastWrite = read
    startSession(false)
    expect(read).toHaveBeenCalledTimes(1)
    await later(0)
    expect(session.updating).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/Vite app.*no trivia:hmr-ready probe/s)

    await later(100)
    unloadAndBegin()
    await later(50)
    const writtenAt = Date.now() // written while the next document loads: still caught at `load`
    lastWrite = async () => writtenAt
    await later(50)
    load()
    await later(0)
    expect(reloads.windows).toEqual([app.win])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('reads ten seconds after the attach when the HMR socket never answers, with one warning', async () => {
    probe = 'pending'
    const read = vi.fn(async () => null)
    lastWrite = read
    startSession(false)
    await later(9_999)
    expect(read).not.toHaveBeenCalled()
    expect(session.updating).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    await later(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/Vite app.*did not answer the trivia:hmr-ready probe within 10 s/s)
    await later(0)
    expect(session.updating).toBe(false)
    connect() // a late answer changes nothing
    await later(0)
    expect(read).toHaveBeenCalledTimes(1)
    expect(listener.settled).toHaveBeenCalledTimes(1)
  })

  it('ends without a reload when the read fails or takes a second', async () => {
    lastWrite = () => Promise.reject(new Error('the engine went away'))
    startSession(false)
    await later(0)
    expect(session.updating).toBe(false)

    await later(100)
    lastWrite = () => new Promise(() => {}) // never answers
    reload()
    await later(999)
    expect(session.updating).toBe(true)
    await later(1)
    expect(session.updating).toBe(false)
    expect(reloads.windows).toEqual([])
    expect(listener.settled).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does nothing for a document that unloads, or a session that stops, while it waits or reads', async () => {
    probe = 'pending'
    const read = vi.fn(async () => Date.now())
    lastWrite = read
    startSession(false)
    await later(100)
    const first = app
    unloadAndBegin() // the user navigated away while its socket connected
    connect(first)
    await later(10_000)
    expect(read).not.toHaveBeenCalled()

    let answer: (at: number) => void = () => {}
    lastWrite = () => new Promise((resolve) => (answer = resolve))
    load()
    connect()
    const second = app
    unloadAndBegin() // gone while the read is on its way
    answer(Date.now())
    await later(0)
    expect(reloads.windows).toEqual([])

    load()
    stop() // the canvas unmounted while its socket connected
    connect(second)
    connect()
    await later(10_000)
    expect(reloads.windows).toEqual([])
    expect(listener.settled).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})
