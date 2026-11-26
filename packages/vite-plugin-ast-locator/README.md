# @trivia/vite-plugin-ast-locator

Dev-only Vite plugin that connects the user's app to the Trivia engine. It does three jobs:

1. **Locators.** During `vite serve`, every JSX opening element in every `.tsx`/`.jsx` module of the
   project gets `data-ast-node="<file>#<component>#<i.j.k>"` as its first attribute, with a source
   map. The engine computes the locators (`annotate`), so stamping and resolving share one algorithm.
   The component library is annotated too; its definition-site locators are overridden by
   usage-site ones wherever the component spreads `{...props}`.
2. **Engine API.** It serves `docs/api.md` at `/@trivia/api/*` from the same dev server.
3. **MCP endpoint.** It serves `docs/mcp.md` at `/@trivia/mcp`, so an agent can edit what the
   user selected in the designer: `claude mcp add --transport http trivia http://localhost:5173/@trivia/mcp`.

```ts
// vite.config.ts — astLocator must come first, before react()
import astLocator from '@trivia/vite-plugin-ast-locator'

export default defineConfig({ plugins: [astLocator(), react(), tailwindcss()] })
```

Build the native engine (`pnpm build:engine`) and this package (`pnpm build:plugin`) first;
`pnpm dev:playground` does both. Without the engine, `vite` stops at startup and says so.

## Options

| Option | Default |
| --- | --- |
| `uiDir` | `components.json` `aliases.ui` mapped through `resolve.alias` (`@/components/ui` → `src/components/ui`); without a matching alias, `@/x` → `src/x`; else `src/components/ui` |
| `importBase` | `components.json` `aliases.ui`, else `@/components/ui` |
| `api` | `true`; `false` serves no API and no MCP endpoint (locators only) |
| `mcp` | `true`: the MCP endpoint at `/@trivia/mcp` (with `api`); `false` turns it off |
| `screenshotTimeoutMs` | `15000`: how long `trivia_screenshot` waits for an open designer to capture the canvas |
| `allowRemote` | `false`: the API answers loopback clients only. **`true` is dangerous**: with `vite --host` or Docker, anyone who can reach the dev server can rewrite your source files |

## Behaviour worth knowing

- Skipped modules: `node_modules`, virtual ids, files outside the root, and ids with a query other
  than the `t`/`v` cache busters (`?raw`, `?url`, …). A module that fails to parse is left alone so
  Vite's own transform reports the syntax error.
- `apply` and `batch` run as one transaction in the binding (`applyOps`): ops are applied to the
  text in memory, then every changed file is written, all or nothing. A failing op writes nothing.
  Vite's watcher picks up the writes and sends a normal HMR update.
- Vite's watcher (the chokidar in Vite 8.3) drops further changes to a file for 50 ms after it
  reports one, so an editor's in-place save (truncate, then write) can reach Vite as an empty
  file. With the API on, the plugin stats a changed project file again 100 ms after its last
  event and, if it moved, emits the change again on `server.watcher` (`src/watch.ts`). The
  engine's own writes get their update the same way, from nothing else: each one renames a
  temporary file over the target, so the file's inode moves and a dropped edit or undo is always
  replayed. Before an edit, undo or redo is answered, the plugin drops the written files' modules
  from Vite's cache (`moduleGraph.onFileChange`), so a request made right after the answer gets
  the new source though the watcher has not reported the write yet.
- Mutating requests run one at a time. Undo/redo restore byte-exact snapshots and answer
  `409 conflict` without writing anything when a file changed outside the designer. With nothing to
  undo or redo they answer `{ files: [] }`.
- Malformed requests (wrong method or content type, bad JSON, unknown endpoint) answer
  `400 invalid_op`.
- The source is laid out as `transform.ts` (locators), `api/` (the HTTP routes, `service.ts`
  with the edit queue, undo history and selection, `guard.ts` with the caller checks) and
  `mcp/` (the endpoint and its tools, over the same service).
- Callers that are not on this machine answer `403 forbidden` on every endpoint: a client address
  that is not loopback (unless `allowRemote`), a `Host` that is not `localhost`, `*.localhost`, an
  IP literal or in `server.allowedHosts` (DNS rebinding), or a foreign `Origin`. See `docs/api.md`,
  Envelope. The MCP endpoint applies the same checks.

```sh
pnpm --filter @trivia/vite-plugin-ast-locator test       # vitest (needs pnpm build:engine)
pnpm --filter @trivia/vite-plugin-ast-locator typecheck
```
