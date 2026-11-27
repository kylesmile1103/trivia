# LLD-13: Trivia on Next.js

- Spec: `specs/013-trivia-on-nextjs` · Requirements: FR-TN-01 to FR-TN-07 · ADR-0017
- Code: `packages/dev-service` (`@trivia/dev-service`, extracted), `packages/next`
  (`@trivia/next`), small changes in `packages/designer/server/` and
  `packages/vite-plugin-ast-locator`.

This feature is independent of LLD-12: it makes the editor work on any App Router app, written
by hand or emitted.

## 1. Spike first

⚑ Pin Next.js **16.4.6**, verified with Node 22.23.3 and React/React DOM 19.2.7.
The scratch App Router app ran on Turbopack with a `*.tsx` rule, a webpack-style loader
calling the built native `annotate` binding, and a MagicString map. Chromium probed the
rendered page, watched it through atomic renames, and fetched the map for a client stack frame.

1. Does a loader registered under `turbopack.rules` for `*.tsx` receive the original TSX,
   before the compiler? Can it return TSX that is then compiled normally?
   **Yes.** The loader checked for `title: string` in the raw input. The rule declared a
   loader with no `as` override, and Next compiled the returned TSX with its original suffix.
2. Does its source map survive, so stack traces and the debugger still point at user lines?
   **Yes with the default compiler configuration.** A callback map with the original path
   and `sourcesContent` mapped the browser stack from its JS chunk to the error at
   `app/source-map/page.tsx:4:17` and supplied the original TSX to the debugger. With React
   Compiler enabled, Next still mapped to the right file and line, but used the stamped TSX as
   `sourcesContent`, so columns after a locator moved. An inline map reproduced that caveat.
3. Do `data-ast-node` attributes on host elements in server components reach the DOM?
   **Yes.** The server `<h1>` was `app/page.tsx#Page#0.0` and the client button was
   `app/client.tsx#Client#0` in Chromium.
4. After the engine's atomic write (temp file and rename), does Fast Refresh pick the change
   up, for a client component and for a server component?
   **Yes.** Both text changes reached the same open document after a sibling temporary
   file was renamed over its source. The client counter kept its state through its refresh.
5. Does the React Compiler, when on, change anything about the first-attribute rule
   (`CLAUDE.md` rule 5)?
   **No.** With `babel-plugin-react-compiler` 1.0.0 enabled, the compiled client bundle used
   the compiler runtime and a button with `{...props}` still received the locator of its
   use in the server page, `app/page.tsx#Page#0.2`.
6. Can a file under `app/(blueprint-preview)/` be added and removed while `next dev` runs
   (LLD-12 section 6)?
   **Yes, using Next's escaped underscore convention.** The literal `__blueprint`
   directory under the group returned 404. Renaming it to `%5F_blueprint` made
   `/__blueprint/Lead` render an unstamped heading, and deleting the group restored 404
   without a restart.

⚑ ADR-0017 supersedes ADR-0015. Keep the verified Turbopack loader and use
`app/(blueprint-preview)/%5F_blueprint/<Name>/` on disk when spec 012 adds blueprint previews.
Its public URL is still `/__blueprint/<Name>`.

## 2. The dev service (FR-TN-02, FR-TN-07)

Today `vite-plugin-ast-locator` holds the locator transform and everything else: the service
(edit queue, undo history, selection), the HTTP routes, the guard, MCP, the Refine adapter, the
routes reader, and soon the blueprint adapter. Only the transform and a few lookups need Vite.

```
packages/dev-service/
  src/api/service.ts    EngineService (moved)
  src/api/http.ts       a Node (req, res, next) handler for /@trivia/api
  src/api/guard.ts      the loopback, Host and Origin checks (moved)
  src/mcp/              the MCP server and tools (moved)
  src/refine/, src/routes/                        the adapters (moved)
  src/engine.ts, src/types.ts                     the native binding and API types (moved)
  src/host.ts           what a host must provide
  src/standalone.ts     a local HTTP server around http.ts and mcp
  bin/trivia-dev.js
```

```ts
interface DevHost {
  root: string
  kind: 'vite' | 'next'
  uiDir: string
  importBase: string
  resolveModule(specifier: string, from: string): Promise<string | null>
  readRoutes(source: RouteSource): Promise<RouteEntry[]> // host-specific
  preview: PreviewHost                              // virtual modules (Vite) or files (Next.js)
  allowedHosts: readonly string[] | true
  filesWritten?(files: readonly string[]): void     // what an edit, undo or redo wrote, before its answer
}
```

The Vite plugin keeps `transform.ts` and becomes a `DevHost` plus one line that mounts
`http.ts` and the MCP handler as middleware. Its options, routes, error codes and tests do not
change. The move is done as pure file moves first (so `git log --follow` works, as in the
earlier reorganization), then the interface is introduced. The plugin's suite and the e2e suite
are the proof of FR-TN-07, and must pass after each of the two steps.

⚑ Lead ordering decision: spec 004 is built on top of this branch and adds its blueprint
routes under `packages/dev-service`. This extraction has no `blueprint/` directory to move.
⚑ Preserve the `api/` directory so all service modules can move byte for byte.
⚑ Unit tests move with their modules. The HTTP and MCP integration tests keep their
assertions and stay where their Vite servers run.
⚑ The Vite gate exposed a Data panel race when a field moved before the next row action
could be clicked. Rows use their field keys and keep actions laid out through a refresh.
Hover and keyboard focus reveal the controls.

⚑ `readRoutes` receives the service's read-only engine helpers. The service merges Refine
labels into the host's `RouteEntry` results, so each host uses the same `AppRoute` contract.
`PreviewHost.publish` receives the compiled page and returns the URL the host made available.

`standalone.ts` listens on `127.0.0.1` only, on a port chosen by the launcher, and applies the
same guard. It serves nothing but `/@trivia/api` and `/@trivia/mcp`.

⚑ The `trivia-dev` CLI can run without an app process. It takes `--root`, `--port`,
`--ui-dir` and `--import-base`. Port zero lets the OS allocate a loopback port. Its static
resolver confines imports to the real project root. Compiling a preview requires an app host.

## 3. Stamping (FR-TN-01, FR-TN-06)

`@trivia/next/loader` is a webpack-style loader:

```js
module.exports = function triviaLoader(source, inputMap) {
  const callback = this.async()
  const file = toProjectRelative(this.resourcePath, this.rootContext)
  const insertions = annotate(source, file)          // @trivia/engine, UTF-16 offsets
  const { code, map } = applyInsertions(source, insertions, file, inputMap)
  callback(null, code, map)
}
```

It is the plugin's `transform.ts` with a different envelope. The insertion and source-map code
moves to a shared module in `@trivia/dev-service` so both use it. Files with no `<` are
returned untouched without calling the engine.

```ts
// next.config.ts
import { withTrivia } from '@trivia/next'
export default withTrivia({ /* the app's config */ })
```

`withTrivia` does nothing unless the phase is the development server. In development it adds
the loader for `.tsx` and `.jsx` under the project, excluding `node_modules` and the preview
folder, through `turbopack.rules` and through a `pre` rule in the webpack config. In a
production build it only checks that no preview folder is left behind.

⚑ `withTrivia` accepts a config object or factory and preserves the app's existing bundler
rules. The application root defaults to the current directory, with an explicit `root` option
for configs loaded from a different working directory.

The file part of a locator is the path relative to the app root, the same string the engine
resolves. One fixture suite, the locator fixtures the engine already has, is run through the
loader to prove equality with the Vite transform (`CLAUDE.md` rule 3).

⚑ The loader takes the app root as an option when the bundler's root can cover a wider
workspace. It composes an incoming source map with the stamp map so previous transforms
remain traceable.

## 4. Designer and launcher (FR-TN-03)

The designer's dev server proxies every path to one target today. It gains a second target for
paths under `/@trivia/`:

| Path | Goes to |
| --- | --- |
| `/__trivia/…` | the designer itself |
| `/@trivia/api/…`, `/@trivia/mcp` | the dev service, when one is configured, else the app's dev server (Vite) |
| everything else, including the HMR WebSocket | the app's dev server |

`server/api-guard.ts` keeps checking API requests before forwarding. The canvas stays
same-origin (rule 7).

⚑ Configure the second proxy with `TRIVIA_API_TARGET`. `TRIVIA_TARGET` remains the app
target. The dev service receives only the API and MCP path families.

`trivia-next dev` (the bin of `@trivia/next`) starts `next dev`, the dev service with a `next`
host, and prints the MCP URL. `Ctrl+C` stops both, and the dev service removes its preview
files on the way out.

⚑ The launcher uses the app's own Next CLI, passes arguments without a shell and runs the
dev service in the launcher process. Both listeners use IPv4 loopback. The app port defaults
to 3000 (or `PORT`) and `--service-port` defaults to an OS-selected port.
⚑ The Next host resolves local imports with the app's TypeScript or JavaScript config.
It reads shadcn's UI alias, with `--ui-dir` and `--import-base` overrides for custom layouts.
⚑ Refine previews use `%5F_blueprint/refine-<id>/page.tsx` under the preview group.
The native guarded writer preserves existing files and cleans only files this launch created
with their expected content, plus the empty directories it created.
⚑ Preview cleanup checks that each directory still resolves to its original path inside the
project before removing it, so a later symlink cannot redirect that removal.

## 5. Routes and pages (FR-TN-04)

`readRoutes` for `next`: walk `app/` for `page.tsx` and `page.jsx`. Route groups `(name)` are
dropped from the URL. `[id]` becomes `:id`, `[...slug]` and `[[...slug]]` become a splat.
Parallel routes (`@slot`), intercepting routes and private folders (`_name`) are skipped. The
result is `AppRoute[]` as `docs/api.md` defines it, with each page's file. Refine labels are
read from the resources array wherever the `<Refine>` element lives.

The `pages/` router is not supported. An app with only `pages/` gets an empty list and a note.

⚑ Use `app/`, falling back to `src/app/` as Next does. `next-app-router` entries point to
the declaring page file even when it re-exports its component. Both catch-all forms use the
existing `*` representation. The route reader decodes the escaped leading underscore and
omits the transient preview group from the Pages tab.
⚑ For Next, the Refine resource search covers project source outside `src/`, including
providers used by App Router layouts.

## 6. Editing server and client components (FR-TN-05)

The engine edits files. It does not care which kind of component a file holds. What changes:

- **Refresh.** After a write, Next.js refreshes a client component in place and re-renders a
  server component through an RSC refresh. `features/canvas/frame-session.ts` listens for iframe
  loads and observes DOM mutations. It does not subscribe to Vite's HMR socket. Its resource
  observer does depend on Vite's `?t=<timestamp>` module requests to match an edit to its
  render; on Next.js it would fall back to a timeout. ⚑ Keep this correlation for Vite.
  For Next.js, `/health` identifies the host and the edit response supplies the files. The
  frame watches their stamped nodes for mutations since the edit was sent, then waits for
  the DOM to settle before re-resolving the selection, with the existing bounded wait.
  The iframe still receives its own HMR connection through the app proxy.
  ⚑ If a document attaches before its first stamped render, the canvas bumps its revision
  once that render is available so the Layers panel can replace its initial empty tree.
  ⚑ (decided 2026-11-26) The Vite host replays a change its file watcher dropped: 100 ms after
  a project file's last `change` event it stats the file again and, when its mtime, size or
  inode moved, emits the change on `server.watcher` (`vite-plugin-ast-locator/src/watch.ts`),
  which takes it through Vite's whole update path, plugins' hooks included. The chokidar in
  Vite 8.3 drops further changes to a file for 50 ms after it reports one, so an editor's
  in-place save (truncate, then write) could leave the canvas on the module transformed from
  the empty file. Next.js has its own watcher and is left alone.
  ⚑ (decided 2026-11-26) The update of an engine write (edit, undo, redo) comes only from that
  watcher, like any other write's, and `DevHost.filesChanged` is gone: #4 had the Vite host call
  `client.reloadModule` on every file the service wrote, because the watcher dropped an undo
  that came a few milliseconds after its edit. Every engine write renames a temporary file over
  the target, so the inode moves and the replay always sees it (creates and deletes are
  `add` and `unlink`, which the throttle leaves alone). `reloadModule` was the weaker path:
  it ran only `updateModules` for client modules already in the graph, skipping the
  environments' `watchChange`, `moduleGraph.onFileChange` and the plugins' `hotUpdate`, and it
  made every engine edit send two updates. Only a dropped write pays for this: its update
  arrives up to about 100 ms later, as a hand edit's already does.
  ⚑ (decided 2026-11-26) Read-after-write: once an edit, undo or redo is answered, every new
  request to the Vite dev server gets the files as written. The service calls
  `DevHost.filesWritten` once they are on disk and before it answers (in an undo or redo, after
  `preview.invalidateBlueprints`, which takes a dropped module for one never loaded), and the
  Vite host only drops their transformed modules: `moduleGraph.onFileChange` in every
  environment, under the root and its real path, sending nothing, so the update stays the
  watcher's one. Without it an e2e trace showed the eject dialog's navigation load `App.tsx` 304
  from before the eject, and the watcher's update reach a document that had not registered the
  module yet, which Vite's client drops: the canvas stayed on the old app. Not covered: a page
  that fetched a module before the write and had not run it when the update came, Vite's
  load-time race for any hand edit. The Next.js host has no such cache and no `filesWritten`.
  ⚑ (decided 2026-11-26) A hot update leaves out the `asset` nodes nothing imports
  (`hotUpdate`, `order: 'pre'`, in `vite-plugin-ast-locator/src/index.ts`), because Vite
  treats such a node as a dead end and reloads the page for it. Tailwind's plugin makes its
  stylesheet depend on every file it scans; after an undo deleted an ejected page and the lock,
  the rebuilt stylesheet dropped them and their nodes stayed behind with no importer, so the
  next eject reloaded the canvas. A node that a stylesheet still imports keeps its CSS update.
  ⚑ (decided 2026-11-26) A Next canvas document catches up once it has hydrated, because Next
  16.4.6 can leave it on the source from before an edit written while it loaded. A hot update
  that reaches it before its React root first commits is lost: React Refresh re-renders only
  mounted roots, and `hydrate()` opens the HMR socket before the root commits. An edit written
  between its HTML and its HMR subscription never reaches it. Once Next's
  `<next-route-announcer>` appears (an effect after the first commit), `frame-session.ts` reads
  `/history`'s `lastWriteAt` (at most 1 s). A write at or after the document's navigation start
  reloads it. Otherwise the canvas calls `window.next.router.refresh()`, which re-renders client
  components from their current modules, at the cost of one RSC render per canvas load. Both
  Next internals live in `next-hydration.ts`.
  ⚑ (decided 2026-11-26) A catch-up reload waits until `COMPILE_GRACE_MS` (500 ms) after the
  write, because a reload 10 ms after a write was itself served stale. A write reaches a page as
  a hot update 60 to 80 ms later on macOS and about 150 ms later on CI. The assumption, not
  verified in Next's code, is that a page requested once Turbopack has seen the change is built
  from it. A catch-up reload's document also counts a write within the grace before its start,
  and a chain reloads at most twice, then refreshes and warns once. Each wait is bounded
  (attach and hydrate 10 s, the read 1 s, the refresh 10 s), and a cut-short catch-up warns
  once. The service and the browser share a host and its clock: a skew costs a reload or misses
  one, never a loop. Nothing tells the canvas when Turbopack has compiled a write, because the
  dev service runs in the launcher, not in Next's process, so the grace is a measured bound.
  ⚑ (decided 2026-11-26) On Next the canvas is busy from its start or a document's unload until
  the next attach (at most 10 s, no warning), and through the catch-up, so that a press on the
  server-rendered page waits and selects on the caught-up render. With no document it is
  dropped. The catch-up's history read is also the designer's history sync, so an edit it
  notices starts its own wait before the catch-up ends. Vite is unchanged.
- **Client boundary props.** An element in a server component that renders a client component
  is still plain JSX with a locator as its first attribute. Nothing special.
- **Prop schemas.** The analyzer reads `src/components/ui` as before. A `"use client"`
  directive at the top of a component file does not affect it.
- **Refine tools.** The page analysis finds `useTable` and form pages in client modules as it
  does on Vite. Route registration differs (files, not `<Route>`), which the adapter learns
  through `DevHost.kind`.
  ⚑ Next scaffolds client `page.tsx` modules with default exports, using the existing
  resource's leading route group when available. The same plan adds the Refine resource
  action. It refuses an already claimed URL pattern, including dynamic parameter renames.
  ⚑ Undo prunes empty App Router directories created by the edit. Turbopack can continue
  serving its cached page after just the file disappears. Pre-existing directories and any
  directory holding user files are preserved.

## 7. Tests

- The loader against the engine's locator fixtures.
- A new example, `examples/next-admin`: the refine-admin pages on App Router, with one server
  component page. A third Playwright project runs a subset of the existing suites on it:
  select, inspect, `updateProp`, `setText`, insert, move, undo and redo, the Pages tab, the
  columns tool on a list page, and one edit to a server component.

  ⚑ The example keeps the bank contract and mock data, ports Refine routing to
  `@refinedev/nextjs-router` 7.0.5, and serves the mock through an App Router route handler.
  Its root server page embeds a small client component so both edit paths are testable.
  ⚑ The `next` Playwright project defaults to app/designer/service ports 5175/4402/4403,
  configurable through `TRIVIA_NEXT_APP_PORT`, `TRIVIA_NEXT_PORT` and `TRIVIA_NEXT_API_PORT`.
  ⚑ (decided 2026-11-26) Specs write and restore example files through `e2e/files.ts`: a
  whole temporary file renamed over the target, then a wait until the dev server serves it.
  For a TypeScript or JSX module of a Vite example, the source in the served module's inline
  source map must equal the bytes written; a file still stale after a second is rewritten,
  five tries, and then the test fails naming it. A restore checks an unchanged file too. A
  fixed wait was all there was before, and a write the watcher dropped left the next test on
  a stale module.
  ⚑ (decided 2026-11-26) The Next.js example's files and files that are not modules keep a
  60 ms wait before the rename and no check, because Next keeps no per-file module to ask
  for and Vite serves no transform of a JSON document the dev service reads from disk.
  ⚑ (decided 2026-11-26) The inspector's "Element not found" test edits `Dashboard.tsx` in
  place with `writeFileSync` and checks without rewriting, because VS Code and Cursor save
  that way and the test is then the replay's end-to-end proof.
  ⚑ (decided 2026-11-26) A checked write has no wait before it, because the check makes it
  redundant: on macOS, the playground and refine projects ran 102 checks with the 60 ms wait
  and 102 without, both times 22 polled for 50 to 170 ms and none needed a rewrite, and a
  write inside the watcher's 50 ms window is the replay's to fix and the check's to prove.
  ⚑ (decided 2026-11-26) The canvas spec removes a button through the API and undoes it at
  once, twenty times in one test, checking each time that Vite serves the original
  (`expectServed`, no rewrite), because the replay is now the only fix for a dropped undo
  and the drop happens on Linux CI, not on macOS.
  ⚑ (decided 2026-11-26) The refine blueprint spec runs eject, undo, eject with no preview open
  and fails on any `full-reload` message the canvas receives from the page's creation on, or a
  lost mark on its window, because each reload it found (a dead end, the route entry, Tailwind's
  for the lock, a stale `App.tsx` after the dialog's navigation) was a product defect.
- The dev service: the plugin's API and MCP suites run unchanged through the Vite host, and a
  smoke subset runs through the standalone server.
- The guard: the standalone server refuses a non-loopback client, a foreign Host and a
  foreign Origin.
- ⚑ The example's build runs `next build` and scans its emitted assets for `data-ast-node`
  and `@trivia/`. The scanner skips the separate development output and build cache.
- ⚑ (decided 2026-11-26) `e2e/next/edit.spec.ts` covers the catch-up with three tests. A
  document is refreshed once, after it hydrated, and is not reloaded when nothing was written.
  An insert over the API the moment a reloaded canvas shows its HTML renders, fifteen rounds in
  a row, each restored once the canvas is no longer busy. A click on the server-rendered
  canvas selects once the canvas has caught up. The insert test still edits early over the
  API, and waits until the designer names its insert ("Insert element") before its
  right-click, because the canvas refuses a right-click while an edit the designer has just
  noticed renders. Before the fix the insert test failed 1 run in 10 locally (1 in 3 to 1 in
  10 on CI), and the race test failed 2 runs in 3. With it (macOS, `pnpm e2e -- --project
  next`): the race test at `--repeat-each=30` passed 30 of 30 (450 rounds), and the FR-TN-05
  spec at `--repeat-each=10` passed 60 of 60.

## 8. Open points

- ⚑ The loader uses Windows-relative path rules for drive and UNC roots and keeps forward
  slashes in locators. The tests cover mixed separators and a different drive.
- ⚑ The launcher reports a Pages Router-only project and rejects a shared explicit app and
  API port up front. An occupied app port exits with Next's error and closes the new service.
- The built integration was checked in the scratch app with webpack and with React Compiler
  on Turbopack. Both stamped client and server JSX and preserved usage-site attribute order.
- ⚑ (decided 2026-11-26) Both Next losses are reported upstream as a draft ([report](../../upstream/next-hmr-lost-updates.md)), and a plain browser
  tab outside the designer still has them (workaround: reload). Residuals in the canvas: a
  plain file write (an IDE's save) between a document's HTML and its HMR subscription is never
  seen by the service. A document that the user or Next loads within the grace after a service
  write (a reload, Next's own reload, a write and then a navigation) can be built from the old
  code, while its window, which starts at its own navigation, leaves the write out. A manual
  canvas reload shows the change in both cases. A component under `React.memo`
  with equal props could in principle survive the router refresh; the probe's refresh rendered
  the change.
- Whether the dev service should also host the designer's static files, so one process serves
  everything for Next.js apps. Later.
