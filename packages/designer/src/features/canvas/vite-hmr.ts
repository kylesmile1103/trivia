// What a Vite canvas document's catch-up relies on (LLD-13 §6), in one place, as next-hydration.ts
// is for Next.js. Verified against vite@8.3.3:
//
// - `dist/client/client.mjs`, `HMRClient.fetchUpdate`: an update for a module that is not in
//   `hotModulesMap` is dropped without a word, and a module registers itself only when it runs.
//   The iframe's `load` event comes after the entry's static module graph has run.
// - `dist/node/chunks/node.js`, `createWebSocketServer`: an update goes to the sockets open at
//   that moment; only `error` and `full-reload` are buffered, and only while no client is
//   connected. The client does not ask for what it missed when it connects (`connected` only
//   logs), and its socket is private: nothing outside the client can tell that it is open.
// - So vite-plugin-ast-locator adds a probe to the app's HTML (its `src/hmr-probe.ts`). It sends
//   HMR_READY over `import.meta.hot`, which waits for the connection; the server answers that
//   socket alone, and the client handles messages in order, so the answer arrives after every
//   update sent before the server knew the socket. On the answer the probe sets
//   `window.__TRIVIA_HMR__.ready` and dispatches HMR_READY on the window.
//
// Once a document has loaded and its socket has answered, no later write can miss it.

/** The probe's custom HMR event, and the window event it dispatches on the answer. */
export const HMR_READY = 'trivia:hmr-ready'

type ProbeWindow = Window & { __TRIVIA_HMR__?: { ready?: unknown } | null }

/**
 * Whether the plugin's probe ran in `win`'s document. It runs before `load` (a module script in
 * <head>); without it the HTML did not go through Vite's index transform, or the plugin is older.
 */
export function hasProbe(win: Window): boolean {
  const probe = (win as ProbeWindow).__TRIVIA_HMR__
  return typeof probe === 'object' && probe !== null
}

/** Whether `win`'s HMR socket has answered the probe. */
export function isConnected(win: Window): boolean {
  return (win as ProbeWindow).__TRIVIA_HMR__?.ready === true
}

/**
 * Calls `onConnected` once `win`'s HMR socket has answered the probe: at once when it already
 * has, else on the probe's window event. Returns the function that stops waiting.
 */
export function whenConnected(win: Window, onConnected: () => void): () => void {
  if (isConnected(win)) {
    onConnected()
    return () => {}
  }
  const listener = () => onConnected()
  win.addEventListener(HMR_READY, listener, { once: true })
  return () => win.removeEventListener(HMR_READY, listener)
}
