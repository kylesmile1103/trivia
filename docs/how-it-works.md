# How it works

```
your Vite app (real files on disk)
  └─ vite-plugin-ast-locator (dev only)
       stamps every JSX opening tag with data-ast-node="<locator>"
       serves the engine HTTP API at /@trivia/api and MCP at /@trivia/mcp

designer (React)  ── <iframe src=your dev server> + transparent overlay
  hover / click  → elementsFromPoint → nearest [data-ast-node] → box on overlay
  inspector      ← prop schemas read from your src/components/ui/*.tsx
  edit           → engine Op { file, locator, op, args }

engine (Rust / OXC)
  parse fresh from disk → resolve locator → compute byte-range edits
  → re-parse the result, refuse on diagnostics → atomic write (temp file + rename)
  → Vite HMR → canvas re-renders → designer re-resolves the selection
```

Key mechanics:

- **Locators** have the form `<relative_path>#<component_or_export>#<index_path>`, for example
  `src/pages/Dashboard.tsx#Dashboard#0.1.3`. A single Rust algorithm produces them, used both by the
  plugin when it stamps the DOM and by the engine when it resolves an edit.
- **Locators are positions, not identities.** Every op carries the expected element name; if the
  locator now resolves to something else, the engine fails loudly instead of editing the wrong node.
- **Same origin.** The designer lives under `/__trivia/` and proxies everything else (HTTP and
  WebSocket) to your dev server, so the canvas can read `iframe.contentDocument`.
- **Imports are derived**, and only for the names an op touched. Trivia never prunes unrelated unused
  imports, because that would be an unrequested edit to your code.

Deeper reading: [`docs/architecture.md`](architecture.md) and [`CLAUDE.md`](../CLAUDE.md).

## Repository layout

```
crates/
  trivia_oxc_engine/          Rust engine (pure library; I/O only in workspace.rs)
  trivia_napi/                napi-rs binding, npm package @trivia/engine (JSON envelope API)
  trivia_shell/               Tauri desktop shell (its own Cargo workspace)
packages/
  vite-plugin-ast-locator/    dev-only Vite plugin: locators, /@trivia/api, /@trivia/mcp, Refine adapter
  designer/                   React designer, @trivia/designer, served at :4400/__trivia/
  contract-sync/              OpenAPI -> hey-api TanStack Query code + trivia.manifest.json
  trivia-inferencer/          @trivia/openapi-inferencer, Refine's inferencer from the contract
examples/
  playground/                 stock create-vite + shadcn app used as the "user app"
  refine-admin/               Refine + shadcn back office on an OpenAPI mock
e2e/                          Playwright across all of the above
tools/                        @trivia/tools: the package generator and the release helpers
docs/                         contracts, architecture, product, hand-off notes
nx.json                       Nx task runner: caching, task order, dev servers, releases
```

Nx runs every task. Each package keeps its own `package.json` scripts; `nx.json` adds caching, the
order tasks run in (a package's dependencies build first) and the long-running `dev` servers. Projects
have short names: `engine`, `oxc-engine`, `plugin`, `contract-sync`, `inferencer`, `designer`,
`playground`, `refine-admin`, `shell`, `e2e` and `tools`. `pnpm graph` shows how they depend on each
other.

Dependencies run one way: designer -> (HTTP) -> plugin -> (napi) -> engine. `contract-sync` writes files
(`trivia.manifest.json`, generated client code) that the engine's `bindQuery` and the designer read;
nothing imports it at runtime.
