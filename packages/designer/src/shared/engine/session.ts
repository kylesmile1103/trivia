// The designer's link to the engine: the startup health check, loading components and
// history into the designer store, and keeping both fresh while the designer is open.
//
// Other clients (agents, a second designer tab, curl) can edit through the same API, so the
// history shown in the toolbar is re-read from the engine rather than trusted locally.

import { toast } from 'sonner'
import { create } from 'zustand'

import { designer } from '@/shared/state/store'

import { ApiError, engine } from './client'

/** docs/api.md — the endpoint the startup check calls, shown when it fails. */
const HEALTH_PATH = '/@trivia/api/health'

/** Why the engine could not be reached, phrased for the person who has to fix it. */
export interface EngineFailure {
  /** Absolute URL that failed. */
  url: string
  /**
   * proxy: the designer's dev server is up but the user's dev server didn't answer;
   * plugin: the user's dev server answered without the engine API (plugin missing);
   * designer: the designer's own dev server is gone;
   * engine: the engine API answered with an error.
   */
  kind: 'proxy' | 'plugin' | 'designer' | 'engine'
  /** HTTP status (0 when the request never completed). */
  status: number
  /** What came back, in the terms of `kind` (the raw client error for engine/designer). */
  message: string
}

export type ConnectionStatus = 'connecting' | 'connected' | 'unreachable'

interface SessionState {
  /** connecting: first health check in flight; unreachable: it failed (full-screen state). */
  status: ConnectionStatus
  /** Connected earlier, but the latest check failed. The workspace stays; the toolbar says so. */
  lost: boolean
  failure: EngineFailure | null
  /** A manual connect/refresh is in flight (spinners). */
  busy: boolean
  componentsLoaded: boolean
  componentsError: string | null
}

export const useSession = create<SessionState>()(() => ({
  status: 'connecting',
  lost: false,
  failure: null,
  busy: false,
  componentsLoaded: false,
  componentsError: null,
}))

const session = useSession

/** Classify a failed engine call (see `request` in ./client.ts for what each status means). */
export function describeFailure(error: unknown, url: string): EngineFailure {
  if (!(error instanceof ApiError)) {
    return { url, kind: 'engine', status: 0, message: error instanceof Error ? error.message : String(error) }
  }
  const { status, message } = error
  if (status === 0) return { url, kind: 'designer', status, message }
  // A JSON error envelope came from the engine itself; anything else came from a server
  // that doesn't speak the API: Vite's proxy answers 5xx (502) with an empty body when the
  // target refuses the connection, and the user's dev server answers its index.html (or a
  // 404) when the plugin isn't installed.
  if (!message.startsWith('engine returned non-JSON')) return { url, kind: 'engine', status, message }
  if (status >= 500) {
    return { url, kind: 'proxy', status, message: `HTTP ${status} from the designer's proxy instead of an engine response` }
  }
  return { url, kind: 'plugin', status, message: `HTTP ${status} with a non-JSON body (not the engine API)` }
}

/**
 * Check health, then load components and history. `manual` shows progress and reports
 * failures as toasts; background checks stay quiet unless the connection state changes.
 */
export async function connect({ manual = false }: { manual?: boolean } = {}): Promise<boolean> {
  if (manual) session.setState({ busy: true })
  try {
    if (!(await checkHealth())) return false
    await Promise.all([
      loadComponents({ manual }),
      readHistory().catch((error: unknown) => {
        if (manual) toast.error(`Couldn't load undo history: ${messageOf(error)}`)
      }),
    ])
    if (manual && session.getState().componentsError === null) {
      const count = designer.getState().components.length
      toast.success(`Reloaded ${count} component${count === 1 ? '' : 's'} from ${designer.getState().health?.uiDir}`)
    }
    return true
  } finally {
    if (manual) session.setState({ busy: false })
  }
}

/** Re-read the component library (the user may have added `src/components/ui/*.tsx`). */
export async function loadComponents({ manual = false }: { manual?: boolean } = {}): Promise<void> {
  try {
    const components = await engine.components()
    const s = designer.getState()
    if (!sameJson(s.components, components)) s.setComponents(components)
    session.setState({ componentsLoaded: true, componentsError: null })
  } catch (error) {
    session.setState({ componentsLoaded: true, componentsError: messageOf(error) })
    if (manual) toast.error(`Couldn't load components: ${messageOf(error)}`)
  }
}

/**
 * Re-read undo/redo state (cheap: the history lives in the dev server's memory). A failure
 * usually means the dev server went away, which the health check then reports.
 */
export async function syncHistory(): Promise<void> {
  if (session.getState().lost) {
    await connect()
    return
  }
  try {
    await readHistory()
  } catch {
    await checkHealth()
  }
}

/** The toolbar's refresh: everything the designer loads from the engine. */
export function refresh(): Promise<boolean> {
  return connect({ manual: true })
}

async function checkHealth(): Promise<boolean> {
  try {
    const health = await engine.health()
    const s = designer.getState()
    if (!sameJson(s.health, health)) s.setHealth(health)
    const { lost } = session.getState()
    session.setState({ status: 'connected', lost: false, failure: null })
    if (lost) toast.success('Reconnected to the engine')
    return true
  } catch (error) {
    const failure = describeFailure(error, new URL(HEALTH_PATH, window.location.origin).href)
    const { status, lost } = session.getState()
    if (status === 'connected') {
      if (!lost) toast.error('Lost the connection to the engine', { description: failure.message })
      session.setState({ lost: true, failure })
    } else {
      session.setState({ status: 'unreachable', failure })
    }
    return false
  }
}

async function readHistory(): Promise<void> {
  const before = designer.getState().history
  const history = await engine.history()
  const s = designer.getState()
  // An edit or undo answered while this read was in flight carries newer state; keep it.
  if (s.history !== before) return
  if (!sameJson(s.history, history)) s.setHistory(history)
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
