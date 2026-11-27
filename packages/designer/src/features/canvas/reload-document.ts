// The catch-up's reload (frame-session.ts, LLD-13 §6), for any host, in a module of its own so
// that the unit tests can stand in for it: jsdom cannot reload a document.

/**
 * Loads the page again: the dev server serves the source as it is now and the browser fetches the
 * current modules. For a document that can have missed an edit, which nothing else can bring to
 * it. On Next.js one written between its HTML and its HMR subscription never reaches it (observed
 * with 16.4.6; `server/dev/hot-reloader-turbopack.js` notes its subscription baseline is not
 * captured atomically), and a router refresh cannot help then, as the document's client modules
 * are the old ones. On Vite an update sent before the page's HMR socket connected, or before the
 * module it updates had run, is dropped for good (vite-hmr.ts).
 */
export function reloadDocument(win: Window): void {
  win.location.reload()
}
