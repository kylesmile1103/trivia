# Report for vercel/next.js (not filed yet)

**Title:** Turbopack dev: Fast Refresh update applied before hydration commit is lost (App Router, 16.4.6)

**Labels to suggest:** Turbopack, Fast Refresh, App Router

## Summary

With `next dev` (Turbopack, App Router), a client component edit whose Fast Refresh update
reaches the page while it is still hydrating never renders. The console shows
`[Fast Refresh] rebuilding` and `[Fast Refresh] done in Nms`, the update message carries the new
module code, and the module is re-evaluated. But the page keeps the pre-edit UI until something
else re-renders that component. `router.refresh()` (or any re-render) then shows the edit.

## Versions

- next 16.4.6 (Turbopack, `next dev`), react / react-dom 19.2.7, Node 22
- Chromium 153 (Playwright 1.63), macOS 26 and Ubuntu (GitHub Actions)
- default config (`experimental.reactDebugChannel` on; it also reproduces with it off)

## Reproduction

1. `app/page.tsx` (server) renders `<EditDemo />` from `components/edit-demo.tsx` (`'use client'`, `useState`, a few elements).
2. Open `/` and change `edit-demo.tsx` on disk (atomic rename or plain save) within ~100 ms
   of first paint: after the HTML is shown, before hydration commits. In our test this is
   "as soon as the server-rendered element is visible".
3. Expected: the page shows the edit. Actual: about one load in ten locally (one in three to one in
   ten on CI) keeps the old UI forever. Making the first client render slower (a heavy page)
   widens the window.

## What happens (instrumented with a `__REACT_DEVTOOLS_GLOBAL_HOOK__` shim)

1. `hydrate()` opens the HMR WebSocket (`client/app-index.js:230`) before
   `await initialServerResponse` (`:232`) and before `hydrateRoot` in `startTransition`
   (`:281`). With the React debug channel on, the initial payload also waits for debug rows that
   arrive over that socket (`REACT_DEBUG_CHUNK`). So the socket is live while the root hydrates.
2. The Turbopack HMR client applies a `turbopack-message` as soon as it arrives (no wait for
   hydration). React Refresh's `performReactRefresh()` calls `setRefreshHandler` for every
   renderer but `scheduleRefresh` only for roots in `mountedRoots`
   (`react-refresh-runtime.development.js:170-282`). A root joins `mountedRoots` on its first
   commit (`:474-512`).
3. A hydrating root is not there yet. If the hydration render has already rendered the edited
   component from the old module, it then commits the old output, and nothing schedules another
   render for it.

Timeline of a lost update (ms from page start, one document):

```
+598 ws-open
+603 edit written (file renamed over)
+647 binary REACT_DEBUG_CHUNK, +653 end of debug channel
+686 turbopack-message (contains the new code) -> setRefreshHandler (renderer 1), no scheduleRefresh
+692 first commit of the #document root (hydration) - old UI
+703 [Fast Refresh] done in 9ms
```

Runs where the root committed before the update show `scheduleRefresh` and the new UI. When the
update arrives before the component renders, React renders the new code during hydration
instead, and the page logs "Hydration failed because the server rendered text didn't match the
client" and regenerates the tree.

## Suggested fixes

- In the HMR client, hold Turbopack updates (or just the React Refresh step) until the App
  Router's root has committed for the first time, as `createProcessTurbopackMessage` already
  queues messages until the HMR client module has loaded, or
- In React Refresh, remember the families updated while a root was not mounted and refresh the
  roots that mount after a pending update (`onCommitFiberRoot`, `!wasMounted && isMounted`).

## Workaround

Call `router.refresh()` (e.g. `window.next.router.refresh()`) once after the first commit.

---

## Second, related race found while testing (same setup): an edit between the HTML response and the HMR subscription is never delivered

Reload the page and write the edit the moment the HTML is visible, before the page's HMR socket
subscribes (~50-100 ms later). In some loads the new document gets no `turbopack-message` for
it at all and no `reloadPage` ("HMR hash mismatch"): `turbopack-subscribe` carries the same
`hmrVersion` the server answers with. The page keeps the old module. Because the module is old,
`router.refresh()` does not help, only a reload. `server/dev/hot-reloader-turbopack.js:814` already notes "Baseline
capture and subscription setup are not atomic". Our reading (not verified in Turbopack's
source): the `clientHmrVersion` check (`:1323`) misses a change detected after the subscribe
message but before the subscription's baseline is captured, so the baseline already contains it.

Suggested fix: capture the subscription's baseline from the client's version (the chunks it
loaded), or bump `clientHmrVersion` as soon as a watched file changes, not only when
Turbopack reports the change.

Workaround: reload the page, but not right away. A reload about 10 ms after the write was
itself served stale: its HTML and client chunks were built from the old file, its socket
subscribed about 50 ms later, and it never got the update either. A write reaches a connected
page as a hot update 60 to 80 ms later on macOS and about 150 ms later on CI. In our tool we
reload no sooner than 500 ms after the write.

(Evidence: Playwright traces of the HMR socket for the failing loads; available on request.)
