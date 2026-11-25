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

Both examples use port 5173, so run one at a time. The engine has no server of its own: it is a napi
addon loaded by the app's Vite dev server, which serves the engine API at `/@trivia/api`.

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

The packages are at `0.1.0` and are consumed from this workspace today. The integration surface is one
plugin.

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

The plugin runs in `vite serve` only (`apply: 'serve'`), skips `node_modules`, and returns a source map.
It will not start without the native engine; `pnpm build:engine` first.

| Option | Default | Purpose |
| --- | --- | --- |
| `uiDir` | derived from `components.json` `aliases.ui` | Where your component library lives. The prop analyzer reads it. |
| `importBase` | `components.json` `aliases.ui`, else `@/components/ui` | Import path used when inserting components. |
| `api` | `true` | `false` serves no API and no MCP endpoint (locators only). |
| `mcp` | `true` | `false` turns off `/@trivia/mcp`. |
| `screenshotTimeoutMs` | `15000` | How long `trivia_screenshot` waits for an open designer. |
| `allowRemote` | `false` | **Dangerous.** See [Security model](../SECURITY.md#security-model). |

Full reference: [`packages/vite-plugin-ast-locator/README.md`](../packages/vite-plugin-ast-locator/README.md).

## Working with AI agents (MCP)

The plugin serves a Model Context Protocol endpoint on your dev server at `/@trivia/mcp` (Streamable
HTTP, stateless, built on the official SDK pinned at 1.30.1). No extra process is needed.

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
