// Keeps the designer's copy of engine state fresh: connects on startup, retries while the
// engine is unreachable, re-reads history while connected, and reloads everything when the
// user comes back to the designer (they may have edited components in their IDE).

import { useEffect, useRef } from 'react'

import { watchFrameWindows } from '@/shared/lib/keyboard'
import { useDesigner } from '@/shared/state/store'

import { startSelectionSync } from './selection-sync'
import { connect, syncHistory, useSession } from './session'

/** History is in the dev server's memory, so this is a cheap GET. */
const HISTORY_POLL_MS = 2000
/** How often an unreachable engine is retried (e.g. while the user starts their app). */
const RETRY_MS = 3000
/** Focus can bounce between the designer and the canvas iframe; reload at most this often. */
const FOCUS_THROTTLE_MS = 1000

export function useEngineSync(): void {
  const status = useSession((s) => s.status)
  const revision = useDesigner((s) => s.revision)
  const inFlight = useRef(false)

  useEffect(() => {
    void connect()
  }, [])

  // Point-and-ask (docs/mcp.md): the plugin keeps the selection for agents.
  useEffect(() => (status === 'connected' ? startSelectionSync() : undefined), [status])

  useEffect(() => {
    if (status === 'connecting') return
    const tick = async () => {
      if (inFlight.current || document.visibilityState !== 'visible') return
      inFlight.current = true
      try {
        await (status === 'connected' ? syncHistory() : connect())
      } finally {
        inFlight.current = false
      }
    }
    const id = window.setInterval(() => void tick(), status === 'connected' ? HISTORY_POLL_MS : RETRY_MS)
    return () => window.clearInterval(id)
  }, [status])

  // The canvas bumps `revision` after HMR: an edit landed, possibly from another client.
  useEffect(() => {
    if (revision > 0) void syncHistory()
  }, [revision])

  useEffect(() => {
    let last = 0
    const onFocus = () => {
      if (useSession.getState().status !== 'connected') return
      const now = Date.now()
      if (now - last < FOCUS_THROTTLE_MS) return
      last = now
      void connect()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onFocus()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    const unwatch = watchFrameWindows((win) => {
      win.addEventListener('focus', onFocus)
      return () => win.removeEventListener('focus', onFocus)
    })
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      unwatch()
    }
  }, [])
}
