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
- The dev service: the plugin's API and MCP suites run unchanged through the Vite host, and a
  smoke subset runs through the standalone server.
- The guard: the standalone server refuses a non-loopback client, a foreign Host and a
  foreign Origin.
- ⚑ The example's build runs `next build` and scans its emitted assets for `data-ast-node`
  and `@trivia/`. The scanner skips the separate development output and build cache.

## 8. Open points

- ⚑ The loader uses Windows-relative path rules for drive and UNC roots and keeps forward
  slashes in locators. The tests cover mixed separators and a different drive.
- ⚑ The launcher reports a Pages Router-only project and rejects a shared explicit app and
  API port up front. An occupied app port exits with Next's error and closes the new service.
- The built integration was checked in the scratch app with webpack and with React Compiler
  on Turbopack. Both stamped client and server JSX and preserved usage-site attribute order.
- Whether the dev service should also host the designer's static files, so one process serves
  everything for Next.js apps. Later.
