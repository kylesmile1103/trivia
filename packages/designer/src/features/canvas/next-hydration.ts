// The Next.js App Router internals the canvas relies on, in one place so that a Next upgrade
// touches one file (LLD-13 §6). Verified against next@16.4.6:
//
// - `client/components/app-router-announcer.js` creates <next-route-announcer> in a useEffect,
//   so it exists only after the App Router's React root has committed its first render
//   (hydration). From then on React Refresh re-renders that root on every hot update.
// - `client/components/app-router-instance.js` assigns the router to `window.next.router`
//   outside React ("for debugging purposes"); its `refresh()` re-renders the page from a fresh
//   server payload, which re-renders client components with their current module code.
// - `client/components/router-reducer/set-cache-busting-search-param.js`: the router's requests
//   for a server payload carry the `_rsc` search parameter.

/** The Next.js version these internals were checked against. */
export const NEXT_VERIFIED = '16.4.6'

/**
 * How long after a file write a page request can still be served from the old code: Turbopack
 * has not noticed the change yet. Measured with next@16.4.6 from a write to its hot update
 * reaching a page: 60 to 80 ms on macOS, about 150 ms on a CI runner; a reload 10 ms after a
 * write was rendered and bundled stale. The assumption (not verified in Next's code): a page
 * requested once Turbopack has seen the change is rendered and bundled from it. About three
 * times the slowest measurement.
 */
export const COMPILE_GRACE_MS = 500

const ANNOUNCER = 'next-route-announcer'
const RSC_PARAM = '_rsc'

type NextWindow = Window & { next?: { router?: { refresh?: unknown } } }

/** Whether the App Router's root has committed its first render in `doc`. */
export function isHydrated(doc: Document): boolean {
  return doc.getElementsByTagName(ANNOUNCER).length > 0
}

/**
 * Calls `onHydrated` once `doc` has hydrated: at once when it already has, else when the route
 * announcer appears. Returns the function that stops waiting.
 */
export function whenHydrated(doc: Document, onHydrated: () => void): () => void {
  if (isHydrated(doc)) {
    onHydrated()
    return () => {}
  }
  const win = doc.defaultView
  if (!win) return () => {}
  // From the frame's realm, so it observes the frame's nodes natively.
  const observer = new win.MutationObserver(() => {
    if (!isHydrated(doc)) return
    observer.disconnect()
    onHydrated()
  })
  observer.observe(doc.documentElement, { childList: true, subtree: true })
  return () => observer.disconnect()
}

/**
 * Asks the app's router for a fresh render of the current page. Returns why it could not, or
 * null once the refresh is on its way.
 */
export function refreshRouter(win: Window): string | null {
  const router = (win as NextWindow).next?.router
  const refresh = router?.refresh
  if (typeof refresh !== 'function') return 'window.next.router.refresh is missing'
  try {
    refresh.call(router)
    return null
  } catch (error) {
    return `window.next.router.refresh() threw: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Whether a resource named `name` is the router's request for a server payload of the page at `location`. */
export function isRouterRequest(name: string, location: Location): boolean {
  let url: URL
  try {
    url = new URL(name)
  } catch {
    return false
  }
  return url.origin === location.origin && url.pathname === location.pathname && url.searchParams.has(RSC_PARAM)
}
