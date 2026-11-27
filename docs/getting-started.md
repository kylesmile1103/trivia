# Getting started

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Rust | 1.97 or newer | Required by OXC 0.153. Developed on 1.99. |
| Node.js | 22 | Developed on 22.16. `@hey-api/openapi-ts` 0.99 declares `>=22.18` but works on 22.16 with a warning. |
| pnpm | 12.9 | Pinned in the root `package.json` (`packageManager`). |
| Chromium | any recent | Only for Playwright e2e tests; install per Playwright's instructions. |
| System webview libraries | platform specific | Only to build the optional desktop shell (webkit2gtk on Linux). |

## Quick start

```sh
pnpm install
pnpm dev               # refine-admin on :5173 and the designer on :4400, in one terminal
#   open http://localhost:4400/__trivia/
```

`pnpm dev` builds what the app needs first (the Rust engine, the plugin, contract-sync), then starts
both servers side by side. Builds are cached: the engine compiles again only when its Rust changed.
Stop everything with Ctrl-C.

| Command | Starts |
| --- | --- |
| `pnpm dev` | the Refine example ([`examples/refine-admin`](../examples/refine-admin/README.md)) and the designer |
| `pnpm dev:playground` | the plain shadcn playground and the designer |
| `pnpm dev:desktop` | the Refine example, the designer and the desktop window |

Both Vite examples default to port 5173. The Vite plugin loads the native engine through the dev
service and mounts `/@trivia/api` on the app's dev server. For the Next.js example, use the launcher
in [the Next.js setup](#using-trivia-in-your-own-nextjs-app).

To run the pieces by hand instead: `pnpm build:plugin`, then `pnpm --filter refine-admin dev` and
`TRIVIA_TARGET=http://localhost:5173 pnpm --filter @trivia/designer dev` in two terminals.

> **Heads up:** end-to-end tests and manual edits modify `examples/**` on disk. Restore with
> `git checkout -- examples/` and confirm `git status` is clean before committing.

### Optional: desktop window

`pnpm dev:desktop` opens it next to the servers. Or install the app: each
[GitHub release](https://github.com/kylesmile1103/trivia/releases) from v0.2.0 carries
`Trivia_<version>_aarch64.dmg` (Apple silicon). It is a window on the designer, so keep `pnpm dev`
running. It is ad-hoc signed, not notarized, so the first time, allow it in System Settings →
Privacy & Security → "Open Anyway". To build it yourself: `nx run shell:bundle`.

From source:

```sh
cargo run --manifest-path crates/trivia_shell/Cargo.toml
# or point it at another designer:
cargo run --manifest-path crates/trivia_shell/Cargo.toml -- http://localhost:4411/__trivia/
```

See [`crates/trivia_shell/README.md`](../crates/trivia_shell/README.md) for status and the pinned Tauri
release set.

## Using Trivia in your own Vite app

Nothing is published to npm yet. Build Trivia in its workspace, then link its packages into your app.
`nx run tools:adopt` runs these steps on a copy of the Refine example outside the workspace, in CI on
every pull request.

1. **Build Trivia.** This also builds the native engine.

   ```sh
   cd /path/to/trivia
   pnpm install
   pnpm exec nx run-many -t build -p plugin contract-sync inferencer
   ```

2. **Link the plugin and contract-sync into your app**, as dev dependencies:

   ```sh
   cd /path/to/your-app
   pnpm add -D link:/path/to/trivia/packages/vite-plugin-ast-locator link:/path/to/trivia/packages/contract-sync
   ```

   Pages that use the inferencer (`OpenApiShowInferencer` and its siblings) need it too:
   `pnpm add link:/path/to/trivia/packages/trivia-inferencer`. These steps are tested with pnpm;
   npm and yarn have their own link commands.

3. **Add the plugin first** in `vite.config.ts`:

   ```ts
   // vite.config.ts
   import astLocator from '@trivia/vite-plugin-ast-locator'
   import react from '@vitejs/plugin-react'
   import { defineConfig } from 'vite'

   export default defineConfig({
     // astLocator must come first: it has to see JSX before React's transform compiles it away.
     plugins: [astLocator(), react()],
   })
   ```

4. **Read your contract** (OpenAPI 3.x or Swagger 2, a file or a URL). This writes
   `trivia.manifest.json`, which the Data tab and the Refine adapter read, and a typed client
   in `src/api/generated`. A Refine app does not use that client; commit it or ignore it as you
   like, but your `tsc` has to accept it ([`docs/data-provider.md`](data-provider.md)).

   ```sh
   pnpm exec trivia-contract-sync --input openapi/your-api.json --output src/api/generated --zod
   ```

5. **Start your app** as usual (`pnpm dev`). In dev mode the plugin stamps every JSX element and
   serves the engine API at `/@trivia/api` and MCP at `/@trivia/mcp` on the same server.

6. **Open the designer** on it, from the Trivia workspace:

   ```sh
   cd /path/to/trivia
   TRIVIA_TARGET=http://localhost:5173 pnpm --filter @trivia/designer dev
   # open http://localhost:4400/__trivia/
   ```

   The designer proxies everything outside `/__trivia/` to `TRIVIA_TARGET`, so the canvas is your
   app on the designer's origin. Agents connect to your app's server (see
   [Working with AI agents](#working-with-ai-agents-mcp)).

**What Trivia expects of the app** (the limits in [`docs/product.md`](product.md), "Known limits"):

- Vite 8 and React. The component palette and prop panels read your shadcn components, located
  through `components.json`.
- For the Refine adapter (pages, columns, fields, contract drift):
  - a page is a file under `src/` that imports `@refinedev/react-table` or
    `@refinedev/react-hook-form`;
  - columns are an array literal in that file, as refine-ui's data table writes them;
  - forms use `zodResolver(schema)` with `<FormField>` or `<Controller>`.

  A page written another way is not read yet, and the Data tab says why (the hook, the line and
  what it found). Your real pages are what decide which shape is supported next.
- Refine 5, for the inferencer.

The plugin runs in `vite serve` only (`apply: 'serve'`), skips `node_modules`, and returns a source map.
It will not start without the native engine, which step 1 builds.

| Option | Default | Purpose |
| --- | --- | --- |
| `uiDir` | derived from `components.json` `aliases.ui` | Where your component library lives. The prop analyzer reads it. |
| `importBase` | `components.json` `aliases.ui`, else `@/components/ui` | Import path used when inserting components. |
| `api` | `true` | `false` serves no API and no MCP endpoint (locators only). |
| `mcp` | `true` | `false` turns off `/@trivia/mcp`. |
| `screenshotTimeoutMs` | `15000` | How long `trivia_screenshot` waits for an open designer. |
| `allowRemote` | `false` | **Dangerous.** See [Security model](../SECURITY.md#security-model). |

Full reference: [`packages/vite-plugin-ast-locator/README.md`](../packages/vite-plugin-ast-locator/README.md).

## Using Trivia in your own Next.js app

The integration supports the App Router on Next.js **16.4.6**. Build Trivia in its workspace,
then link the integration into your app.

```sh
cd /path/to/trivia
pnpm install
pnpm exec nx build next
cd /path/to/next-app
pnpm link /path/to/trivia/packages/next
```

Wrap your existing Next.js config.

```ts
// next.config.ts
import { withTrivia } from '@trivia/next'

export default withTrivia({})
```

Start Next.js and the local dev service from the app directory. Add `--webpack` to use webpack.

```sh
pnpm exec trivia-next dev --port 3000 --service-port 4403
```

The launcher prints the API and MCP URLs. In the Trivia workspace, start the designer with both
targets and open `http://localhost:4400/__trivia/`.

```sh
TRIVIA_TARGET=http://127.0.0.1:3000 TRIVIA_API_TARGET=http://127.0.0.1:4403 \
  pnpm --filter @trivia/designer dev
```

The designer keeps the canvas on its own origin and sends the API and MCP requests to the service.
The Next loader runs only in development. Production builds use the app's normal bundler config
and refuse a leftover `app/(blueprint-preview)/` folder. See [Engine API](api.md) and the
[Next.js example](../examples/next-admin/).

## Working with AI agents (MCP)

The dev service serves a Model Context Protocol endpoint at `/@trivia/mcp` (stateless Streamable
HTTP, official SDK 1.32.2). For Vite, use the app's dev-server URL. For Next.js, use the MCP URL
printed by `trivia-next dev`.

```sh
claude mcp add --transport http trivia http://localhost:5173/@trivia/mcp
```

Or commit it in `.mcp.json`:

```json
{ "mcpServers": { "trivia": { "type": "http", "url": "http://localhost:5173/@trivia/mcp" } } }
```

**Point and ask.** Select an element on the canvas, then tell your agent "make this an outline button" or
"put a New badge before this". The agent reads the selection, applies guarded ops, and the designer
shows the edit immediately.

| Tool | Purpose |
| --- | --- |
| `trivia_get_selection`, `trivia_inspect`, `trivia_outline`, `trivia_list_components`, `trivia_list_routes` | Read the selection, a node, a file's element tree, the component library, and the app's routes with each page's file. |
| `trivia_apply` | Apply one or more ops as a single undo entry labelled `Agent: ...`. Every stale-locator guard is required. |
| `trivia_undo` | Undo the newest entry only if its label matches, so a user's own edit is never undone by mistake. |
| `trivia_screenshot` | The canvas as a PNG, so the agent can check its own edit. |
| `trivia_sync_openapi` | Regenerate the typed client and manifest from the spec. Refused over uncommitted generated code unless `force`. |
| `trivia_get_page`, `trivia_edit_columns`, `trivia_edit_fields`, `trivia_contract_drift`, `trivia_add_pages` | The Refine adapter. |

Details, prompts that were tried with a real Claude Code session, and error semantics:
[`docs/mcp.md`](mcp.md).
