# Trivia

**A local-first visual editor for React that edits your real source code, byte for byte.**

Trivia lets a developer (or an AI agent) point at an element on a live canvas and change it, and the
change lands in the actual `.tsx` file as a minimal text splice. There is no DSL, no sidecar JSON, no
generated-code region and no reformatting: everything you did not touch stays exactly as you wrote it,
down to the whitespace and comments.

> In compiler terms, *trivia* is the whitespace and comments that a normal AST round-trip throws away.
> Preserving it is the product, not a nice-to-have.

| | |
| --- | --- |
| **Status** | Pre-1.0. Exercised end to end on this repository's Vite and Next.js examples. |
| **Target user** | Developers who maintain internal tools and admin consoles built with Refine + shadcn/ui on OpenAPI backends ("day 2": the code already exists). See [`docs/product.md`](docs/product.md). |
| **License** | MIT (declared in the Cargo manifests). |
| **Runs where** | Entirely on your machine. No cloud service, no telemetry, no account. |

---

## Table of contents

1. [Why Trivia](#why-trivia)
2. [Key capabilities](#key-capabilities)
3. [How it works](#how-it-works)
4. [Repository layout](#repository-layout)
5. [Prerequisites](#prerequisites)
6. [Quick start](#quick-start)
7. [Using Trivia in your own Vite app](#using-trivia-in-your-own-vite-app)
8. [Using Trivia in your own Next.js app](#using-trivia-in-your-own-nextjs-app)
9. [Working with AI agents (MCP)](#working-with-ai-agents-mcp)
10. [The Refine + OpenAPI workflow](#the-refine--openapi-workflow)
11. [Design guarantees](#design-guarantees)
12. [Security model](#security-model)
13. [Development](#development)
14. [Testing and quality gates](#testing-and-quality-gates)
15. [Documentation index](#documentation-index)
16. [Known limitations](#known-limitations)
17. [Roadmap](#roadmap)
18. [Contributing](#contributing)
19. [Acknowledgements and prior art](#acknowledgements-and-prior-art)
20. [License](#license)

---

## Why Trivia

Visual editing of real code is no longer rare. What blocks adoption by working developers is trust:
tools that re-print a whole file after every click produce diffs nobody wants to review. Trivia is built
around the opposite rule.

- **Byte-preserving edits.** The engine parses with [OXC](https://oxc.rs), uses the AST only to find
  spans, and applies insert, replace and delete ranges to the original text. It never re-prints. A
  probe of OXC's code generator showed it adds semicolons, converts indentation to tabs and drops the
  parentheses in `return ( ... )`, so it is not used for writes.
- **Your source stays the source of truth.** Edit in the designer, in your IDE, or through an agent.
  All three act on the same files, and Vite HMR or Next.js Fast Refresh keeps the canvas in sync.
- **Guarded, reviewable operations.** Every change is one serializable `Op` with a stale-locator guard.
  Each is atomic, lands in an undo history as one entry, and is refused (never guessed) when the
  source no longer matches what the caller expected.
- **Contract-aware.** For Refine apps, Trivia connects the OpenAPI contract to the pages: columns,
  form fields, drift after a spec change, and new resource pages are planned from the contract and
  written as ordinary code.
- **No runtime added to your app.** Trivia is dev-only. The generated data layer depends on
  `@tanstack/react-query` and nothing proprietary.

---

## Key capabilities

| Area | What you get |
| --- | --- |
| **Visual canvas** | Your running app in a same-origin iframe with a hit-testing overlay, hover and selection boxes, drag to move, drop zones, zoom to fit, and a right-click menu for structure edits. |
| **Inspector** | Prop editors built from your own `src/components/ui/*` (variants from `cva(...)`, defaults, enum options), a Tailwind class manager and a style panel with two-phase editing (live CSS preview during a gesture, Tailwind classes written on commit). |
| **Palette and Layers** | Insert any component from your library; a Layers tree of the rendered app, rearranged by dragging rows (before, after, inside) or with Alt+↑/↓; move elements across files with imports carried along. |
| **Pages** | The app's routes, read from its source (React Router, TanStack Router, or Next.js App Router), with Refine labels and page files. Click a route to load it in the canvas or type a path. |
| **Engine ops** | `insert`, `insertChild`, `updateProp`, `setText`, `remove`, `move`, `moveNode`, `bindQuery`, `createFile`, plus value ops (`insertElement`, `removeElement`, `moveElement`, `setProperty`, `removeProperty`) for object and array literals. |
| **Undo / redo** | Guarded before/after snapshots. Byte-exact; refuses with `409 conflict` if a file changed elsewhere. |
| **Data tab** | Bound tables and create forms from an OpenAPI contract (TanStack Query, react-hook-form, zod, shadcn `Field`). |
| **Refine tools** | Columns, form fields, contract drift and new-resource pages, each as a single undo entry. |
| **MCP endpoint** | "Point and ask": select an element, tell your agent what to change, and it edits through the same guarded ops. |
| **Desktop shell** | An optional Tauri window on the designer, also as a macOS app (`.dmg` on each GitHub release). |

---

## How it works

```
your React app (real files on disk)
  ├─ Vite plugin or Next.js loader stamps JSX with data-ast-node="<locator>" in development
  └─ Trivia dev service serves /@trivia/api and /@trivia/mcp

designer (React)  ── <iframe src=your dev server> + transparent overlay
  hover / click  → elementsFromPoint → nearest [data-ast-node] → box on overlay
  inspector      ← prop schemas read from your src/components/ui/*.tsx
  edit           → engine Op { file, locator, op, args }

engine (Rust / OXC)
  parse fresh from disk → resolve locator → compute byte-range edits
  → re-parse the result, refuse on diagnostics → atomic write (temp file + rename)
  → Vite HMR or Next.js Fast Refresh → canvas re-renders → designer re-resolves the selection
```

Key mechanics:

- **Locators** have the form `<relative_path>#<component_or_export>#<index_path>`, for example
  `src/pages/Dashboard.tsx#Dashboard#0.1.3`. A single Rust algorithm produces them, used both by the
  development hosts when they stamp JSX and by the engine when it resolves an edit.
- **Locators are positions, not identities.** Every op carries the expected element name; if the
  locator now resolves to something else, the engine fails loudly instead of editing the wrong node.
- **Same origin.** The designer lives under `/__trivia/` and proxies the canvas and its WebSocket
  to the app's dev server. With Next.js, it sends Trivia API and MCP requests to the standalone service.
- **Imports are derived**, and only for the names an op touched. Trivia never prunes unrelated unused
  imports, because that would be an unrequested edit to your code.

Deeper reading: [`docs/architecture.md`](docs/architecture.md) and [`CLAUDE.md`](CLAUDE.md).

---

## Repository layout

```
crates/
  trivia_oxc_engine/          Rust engine (pure library; I/O only in workspace.rs)
  trivia_napi/                napi-rs binding, npm package @trivia/engine (JSON envelope API)
  trivia_shell/               Tauri desktop shell (its own Cargo workspace)
packages/
  vite-plugin-ast-locator/    dev-only Vite host and locator transform
  dev-service/                shared stamping, engine HTTP API, MCP and Refine adapter
  next/                       Next.js App Router host, loader, config wrapper and launcher
  designer/                   React designer, @trivia/designer, served at :4400/__trivia/
  contract-sync/              OpenAPI -> hey-api TanStack Query code + trivia.manifest.json
  trivia-inferencer/          @trivia/openapi-inferencer, Refine's inferencer from the contract
examples/
  playground/                 stock create-vite + shadcn app used as the "user app"
  refine-admin/               Refine + shadcn back office on an OpenAPI mock
  next-admin/                 the Refine bank example ported to Next.js App Router
e2e/                          Playwright across all of the above
tools/                        @trivia/tools: the package generator and the release helpers
docs/                         contracts, architecture, product, hand-off notes
nx.json                       Nx task runner: caching, task order, dev servers, releases
```

Nx runs every task. Each package keeps its own `package.json` scripts; `nx.json` adds caching, the
order tasks run in (a package's dependencies build first) and the long-running `dev` servers. Projects
have short names such as `engine`, `plugin`, `dev-service`, `next` and `designer`. `pnpm graph` shows
how they depend on each other.

The designer calls the dev service over HTTP, and the dev service calls the engine through napi. `contract-sync` writes files
(`trivia.manifest.json`, generated client code) that the engine's `bindQuery` and the designer read;
nothing imports it at runtime.

---

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Rust | 1.97 or newer | Required by OXC 0.153. Developed on 1.99. |
| Node.js | 22 | Developed on 22.16. `@hey-api/openapi-ts` 0.99 declares `>=22.18` but works on 22.16 with a warning. |
| pnpm | 12.9 | Pinned in the root `package.json` (`packageManager`). |
| Chromium | any recent | Only for Playwright e2e tests; install per Playwright's instructions. |
| System webview libraries | platform specific | Only to build the optional desktop shell (webkit2gtk on Linux). |

---

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
| `pnpm dev` | the Refine example ([`examples/refine-admin`](examples/refine-admin/README.md)) and the designer |
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

See [`crates/trivia_shell/README.md`](crates/trivia_shell/README.md) for status and the pinned Tauri
release set.

---

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
| `allowRemote` | `false` | **Dangerous.** See [Security model](#security-model). |

Full reference: [`packages/vite-plugin-ast-locator/README.md`](packages/vite-plugin-ast-locator/README.md).

---

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
and refuse a leftover `app/(blueprint-preview)/` folder. See [Engine API](docs/api.md) and the
[Next.js example](examples/next-admin/).

---

## Working with AI agents (MCP)

The dev service serves a Model Context Protocol endpoint at `/@trivia/mcp` (stateless Streamable
HTTP, official SDK 1.30.1). For Vite, use the app's dev-server URL. For Next.js, use the MCP URL
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
[`docs/mcp.md`](docs/mcp.md).

---

## The Refine + OpenAPI workflow

For apps built with Refine, shadcn/ui and an OpenAPI backend, Trivia treats the API contract as the
source of truth and plans page edits from it. The weekly jobs, in order:

1. **Columns.** Add, remove or reorder a list column from the contract. The cell renders by field type
   (badge for enums, formatted dates, Yes/No for booleans) and gets the matching filter.
2. **Form fields.** Add a contract field to a create/edit form: the zod rule with the contract's bounds,
   the default value and the field control in the form's own style (a `Controller` with shadcn's `Field`,
   or Refine's `<FormField>`) with a widget chosen by type, as one undo entry. It goes where the contract
   puts it, inside the developer's own grid or card.
3. **Contract drift.** After a spec change, list what each page references that the contract removed,
   retyped or newly requires, each with a one-click fix.
4. **New resource.** Generate the list, create, edit and show pages for a contract resource, register
   them in `<Refine resources>` and add the routes. Or drop `<OpenApiListInferencer />` (from
   `@trivia/openapi-inferencer`, a contract-driven replacement for Refine's inferencer) into a route.
   The page runs live, even with no records, and **Eject to disk** writes it and switches the route
   over.

Behind it, `@trivia/contract-sync` turns the spec into typed code and a deterministic
`trivia.manifest.json`:

```sh
pnpm --filter @trivia/contract-sync build
trivia-contract-sync --input openapi/customers.openapi.json --zod
trivia-contract-sync --input https://api.example.com/openapi.json --output src/api/generated
trivia-contract-sync --supabase-url https://<ref>.supabase.co --supabase-key "$TRIVIA_SUPABASE_KEY"
```

Generation is staged and verified; if anything mismatches, nothing in your project changes. Exit codes:
`0` ok, `1` failure, `2` usage error. Design and the `bindQuery` contract:
[`docs/data-provider.md`](docs/data-provider.md). Product rationale: [`docs/product.md`](docs/product.md).

---

## Design guarantees

These are enforced by tests, not just intended.

| Guarantee | How it is enforced |
| --- | --- |
| Bytes outside the edited ranges are unchanged | Exhaustive round-trip suite (also run on CRLF copies); fixtures pin real-world formatting cases. |
| A write never leaves a file that fails to parse | The result is re-parsed; the engine refuses to write if there are diagnostics. |
| A write is all or nothing | Multi-file batches run in memory and are written together; a failing op writes nothing. Writes are temp file plus rename. |
| A stale locator never edits the wrong node | Every op carries the expected element name; mismatches answer `409 stale_locator`. |
| Moves keep identifier scope | A move out of a `.map` callback or between components is refused unless every identifier still resolves to the same symbol. |
| One locator algorithm | The plugin and the engine share the Rust implementation. |
| Hostile or huge input is bounded | Files whose locators would exceed 2^22 segments are refused (`422 unsupported`); the napi crash suite bounds peak memory at 512 MiB per case. |
| Layering rules hold | `packages/designer/src/architecture.test.ts` enforces `app -> features -> shared` and no feature-to-feature imports. |

Offsets are UTF-8 bytes in Rust and UTF-16 in JavaScript. The binding converts at the boundary, and no
offset crosses it without a stated unit.

---

## Security model

Trivia's API **writes to your source files**, so it only answers the machine it runs on.

Every request under `/@trivia/api/` and `/@trivia/mcp` is refused with `403 forbidden` unless all of
these hold:

- the client address is loopback (`127.0.0.0/8`, `::1`, including IPv4-mapped);
- the `Host` names this machine (`localhost`, `*.localhost`, an IP literal, or an entry in Vite's
  `server.allowedHosts`), which blocks DNS rebinding;
- the `Origin`, when present, is a localhost origin (the opaque `null` origin is refused).

The designer's proxy applies the same three checks itself before forwarding, so starting the designer
with `--host` still does not expose the API to other machines. Mutating requests must be `POST` with
`content-type: application/json`.

`allowRemote: true` lifts the client-address check only. With `vite --host` or Docker, anyone who can
reach the dev server could then rewrite your source. Do not enable it on an untrusted network.

Trivia is dev-only: the plugin does not run in production builds, and nothing it adds ships to your users.

To report a vulnerability, contact the maintainer privately rather than opening a public issue.

---

## Development

```sh
pnpm install
pnpm check                                   # build, typecheck, lint and test everything (cached)
pnpm affected                                # the same, only for what your changes touch
nx test plugin                               # one project's target (builds what it needs first)
nx run-many -t test -p designer plugin       # one target, several projects
pnpm graph                                   # the project graph in the browser

cargo test -p trivia_oxc_engine --test roundtrip             # one Rust suite (~15 s, exhaustive)
cargo test -p trivia_oxc_engine --test acceptance move_      # filter by test name
```

`nx` is `pnpm exec nx` (or `npx nx`). Nx caches `build`, `typecheck`, `lint` and `test` in `.nx/`
(gitignored). A test's cache key includes `examples/**` and `docs/**`, which the suites read. Add
`--skip-nx-cache` to force a run. Nx Cloud and analytics are off (`nx.json`), and no Nx daemon is left
running.

New package: `nx g @trivia/tools:package <name>` writes `packages/<name>` set up like
`contract-sync` (strict tsconfig, vitest, build/typecheck/test scripts) and adds it to the release.

Where code goes:

- **Engine:** pure Rust. Each write op is one module under `crates/trivia_oxc_engine/src/ops/`. A new op
  is a new module, an `Op` variant and a `docs/api.md` example (`tests/errors.rs` pins one per variant).
- **Dev service:** `api/` (routes, edit queue, undo history, caller guard), `mcp/` (tools) and
  `refine/` (the Refine adapter). Both the Vite and Next.js hosts use `EngineService` for edits.
- **Designer:** `app/` -> `features/<name>/` (public API in `index.ts`) -> `shared/`. A feature never
  imports another feature.
- **OXC:** every OXC crate is pinned to one exact version (`=0.153.0`). The API moves quickly, so check
  names against the OXC source before writing engine code.

Conventions, design rules and gotchas are in [`CLAUDE.md`](CLAUDE.md); the working notes for picking up
the project are in [`docs/HANDOFF.md`](docs/HANDOFF.md).

---

## Testing and quality gates

`pnpm check` is the gate without end to end; `pnpm e2e` adds that. By project:

| Layer | Command | What it covers |
| --- | --- | --- |
| Engine | `nx test oxc-engine` | Acceptance, round-trip, formatting, guards, imports, locators, scope checks, outline, error codes, stack budget. |
| Binding | `nx test engine` | Its Rust tests, then the napi crash suite (deep files, bounded memory). |
| Lint | `pnpm lint` | Clippy with `-D warnings` on every crate, oxlint on the designer and the examples. |
| Dev hosts | `nx run-many -t test -p dev-service plugin next` | HTTP API, MCP, Refine adapter, App Router routes and loader parity. |
| Designer | `nx test designer` | Unit tests plus architecture rules. |
| Contract sync | `nx test contract-sync` | The whole pipeline and the CLI. |
| Inferencer | `nx test inferencer` | The package's hooks and eject requests. |
| Types | `pnpm typecheck` | All TypeScript packages. |
| Builds | `pnpm build` | Every package, plus production builds of the designer and the examples. |
| End to end | `pnpm e2e` | Playwright projects `playground`, `refine` and `next`, each with its own servers. |
| Desktop shell | `nx test shell` | The shell's own Cargo workspace. |
| Tooling | `nx test tools` | The generator, the release version actions and changelog rules. |

Playwright ports come from the environment so you can run beside a live session:

```sh
TRIVIA_APP_PORT=5311 TRIVIA_PORT=4411 \
TRIVIA_REFINE_APP_PORT=5312 TRIVIA_REFINE_PORT=4412 \
TRIVIA_NEXT_APP_PORT=5313 TRIVIA_NEXT_PORT=4413 TRIVIA_NEXT_API_PORT=4513 \
  pnpm e2e
```

`pnpm e2e` builds the Vite and Next.js packages first. There is no hosted CI
configuration in this repository yet, so run the gate locally before pushing.

### Releases

Every package and crate shares one version, tagged `v<version>`.

```sh
pnpm release 0.2.0 --dry-run     # preview: versions, CHANGELOG.md entry, GitHub release
pnpm release 0.2.0               # or: pnpm release minor
```

A release:
- bumps each `package.json`, `Cargo.toml`, `tauri.conf.json` and `Cargo.lock` entry in place;
- writes `CHANGELOG.md` with a section per commit prefix (`engine:`, `designer:`, `MCP:`, …);
- commits `release: v<version>`, tags, pushes, and creates the GitHub release;
- builds the desktop app and attaches `Trivia_<version>_aarch64.dmg` to the release, with a note
  on opening it (`pnpm release:desktop v<version>` redoes just this step);
- never publishes to npm.

It starts from a clean `main` on a Mac (the desktop app is bundled on macOS). It refuses to run when a commit since the last release has a prefix
that `nx.json` doesn't list, because Nx would leave that commit out of the changelog. The GitHub token
comes from `GH_TOKEN`, `GITHUB_TOKEN` or git's credential helper.

---

## Documentation index

| Document | Contents |
| --- | --- |
| [`docs/product.md`](docs/product.md) | Who Trivia is for, the jobs in priority order, slices and their status. |
| [`docs/architecture.md`](docs/architecture.md) | Package layout, the designer's layering rules, engine op modules. |
| [`docs/api.md`](docs/api.md) | The engine HTTP contract: envelope, endpoints, every `Op`, error codes. |
| [`docs/mcp.md`](docs/mcp.md) | The MCP endpoint, tools, selection sync, and a real agent session. |
| [`docs/data-provider.md`](docs/data-provider.md) | contract-sync design, the manifest, and the `bindQuery` contract. |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Current status, decisions and their reasons, catches, backlog. |
| [`docs/briefs/`](docs/briefs) | The original briefs, kept verbatim for history. `CLAUDE.md` wins on conflicts. |
| [`CLAUDE.md`](CLAUDE.md) | Load-bearing design rules and verified OXC 0.153 API corrections. |

---

## Known limitations

Stated plainly so you can judge fit before investing time.

- **Not yet validated on third-party code.** The three examples are the only apps exercised end to end.
  What breaks on a real codebase is the next input to the roadmap.
- **React dev hosts.** Supported hosts are Vite and Next.js App Router. The Refine adapter is built
  around shadcn/ui.
- **No type checker.** OXC has none, so prop schemas come from syntactic analysis of your
  `src/components/ui` (variants from `cva(...)`, curated props for intrinsic tags). Unusual component
  patterns may yield partial schemas.
- **Structural and value edits renumber locators.** The designer and agents drop a selection that a
  renumbering invalidates rather than guess a new target.
- **Refine adapter scope.** Pages are found in `src/` files importing `@refinedev/react-table` or
  `@refinedev/react-hook-form`. Forms built with `register()` or another resolver are not read.
  Drift reads enum options from the first 600 bytes of a column header. A rebuilt column or field takes
  the generated shape, replacing custom cells or widgets in it. Edit forms (an update body plus loading
  the row) and nested-object form fields are not generated yet.
- **Desktop shell.** Verified on macOS (WKWebView) only; no Linux or Windows hand test. The packaged
  app is Apple silicon only, and ad-hoc signed rather than notarized (no Apple Developer ID).
- **Packages are not published to npm** at this stage; use the workspace.

---

## Roadmap

In priority order (see [`docs/HANDOFF.md`](docs/HANDOFF.md) section 7 for the live list):

1. Use Trivia on a real internal tool and fix what breaks: pages whose shape the adapter does not read,
   other UI kits, selection that follows JSX renumbered by a value op.
2. Narrower drift fixes for changed enum options (update in place instead of rebuilding).
3. Edit forms and nested-object fields in generated forms.

General editor features (canvas, inspector, style controls) are frozen to fixes until the jobs above
are in real use.

---

## Contributing

1. Read [`CLAUDE.md`](CLAUDE.md) and [`docs/architecture.md`](docs/architecture.md) first. The rules are
   load-bearing: never reprint a file, never mix UTF-8 and UTF-16 offsets, never prune unrelated imports.
2. Keep changes inside the right slice. Add a failing test before fixing a bug.
3. Run the relevant gate from [Testing and quality gates](#testing-and-quality-gates) (`pnpm affected`
   covers what you touched). Re-run the whole suite after touching docs: `errors.rs` pins one
   `docs/api.md` example per `Op`.
4. Start each commit message with its area, `<area>: <what changed>` (`engine:`, `plugin:`,
   `designer:`, `MCP:`, `docs:`, `repo:`, …). The changelog groups commits by it, and `pnpm release`
   refuses an area that `nx.json` does not list.
5. Leave `examples/**` clean (`git checkout -- examples/`) and do not bypass commit hooks.
6. Open a pull request describing the behavior change and how you verified it.

---

## Acknowledgements and prior art

- [NetEase Tango](https://github.com/NetEase/tango): the idea of editing the real source AST with no DSL.
  Trivia replaces its Babel + Prettier write path with byte-range splicing.
- [OXC](https://oxc.rs): the parser and semantic analysis behind the engine.
- [Onlook](https://github.com/onlook-dev/onlook): two-phase editing and a single serializable action
  vocabulary.
- [hey-api/openapi-ts](https://heyapi.dev): the OpenAPI to TanStack Query code generator used by
  contract-sync.
- [shadcn/ui](https://ui.shadcn.com), [Refine](https://refine.dev), [Vite](https://vite.dev),
  [napi-rs](https://napi.rs) and [Tauri](https://tauri.app).

---

## License

MIT, as declared in the workspace Cargo manifests. A standalone `LICENSE` file has not been added to the
repository root yet.
