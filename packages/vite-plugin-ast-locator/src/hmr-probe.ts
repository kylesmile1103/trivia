// The page's half of a Vite canvas document's catch-up (docs/blueprint/lld/LLD-13-trivia-on-nextjs.md
// §6); the designer's half is packages/designer/src/features/canvas/vite-hmr.ts. Verified against
// vite@8.3.3: an update broadcast before the server has a page's HMR socket never reaches that
// page (only `error` and `full-reload` are buffered, and only while there is no client at all),
// and nothing about the socket is observable from outside the page's Vite client. So the plugin
// adds this probe to the app's HTML. It sends HMR_READY over `import.meta.hot`, which waits for
// the connection; the server answers that socket alone (index.ts, configureServer); the client
// handles messages in order, so the answer arrives after every update broadcast before the
// server knew the socket. On the answer the probe sets `window.__TRIVIA_HMR__.ready` and
// dispatches HMR_READY on the window.

/** The custom HMR event: the page sends it, and the server sends it back to that page alone. */
export const HMR_READY = 'trivia:hmr-ready'

/**
 * The probe's module id. Virtual, so that nothing takes it for a file: the transform never
 * stamps it (VIRTUAL_ID), and `invalidatePreviews` (host.ts) never reloads the page for it, which
 * it would for any module under `src/.trivia-preview/`.
 */
export const HMR_PROBE_ID = '\0' + HMR_READY

/** Where a page loads the probe from, under the server's base: Vite serves a virtual id at `/@id/`, `\0` spelled `__x00__`. */
export const HMR_PROBE_URL = '/@id/__x00__' + HMR_READY

/** The probe's code. Without `import.meta.hot` (HMR off) it never answers, and the canvas reads after its timeout. */
export const hmrProbe = [
  'const probe = { ready: false }',
  'window.__TRIVIA_HMR__ = probe',
  'if (import.meta.hot) {',
  '  import.meta.hot.on(' + JSON.stringify(HMR_READY) + ', () => {',
  '    if (probe.ready) return',
  '    probe.ready = true',
  '    window.dispatchEvent(new Event(' + JSON.stringify(HMR_READY) + '))',
  '  })',
  '  import.meta.hot.send(' + JSON.stringify(HMR_READY) + ')',
  '}',
  '',
].join('\n')
