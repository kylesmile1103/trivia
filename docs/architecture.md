# Architecture: where code goes

Trivia is organized by **deployable at the top and by feature inside**. A feature such as
`bindQuery` spans three runtimes: Rust (the engine edits the file), Node (the plugin serves
it over HTTP) and the browser (the designer offers it). Those are separate build targets, so
the repo splits by package, and each package splits into vertical slices of its own.

```
crates/
  trivia_oxc_engine/      the engine: pure Rust library (I/O only in workspace.rs)
  trivia_napi/            its Node binding, npm package @trivia/engine
  trivia_shell/           the desktop shell (Tauri): a window on the designer; its own workspace
packages/
  vite-plugin-ast-locator/  dev-only Vite host: stamps locators and mounts the dev service
  dev-service/            engine API, MCP, shared stamping, Refine adapter and edit history
  next/                   dev-only Next.js loader, config wrapper, App Router host and launcher
  designer/               the React designer, @trivia/designer
  contract-sync/          OpenAPI → hey-api code + trivia.manifest.json, @trivia/contract-sync
  trivia-inferencer/      @trivia/openapi-inferencer: Refine's inferencer, from the contract
examples/playground/      the "user app" for the editor's manual and e2e checks
examples/refine-admin/    a Refine + shadcn back office on an OpenAPI mock: the Refine work's user app
examples/next-admin/      the bank example on Next.js App Router, with server and client components
e2e/                      Playwright projects for playground, refine-admin and next-admin
tools/                    @trivia/tools: the package generator and the release helpers (Nx)
nx.json                   the task runner: caching, task order, dev servers, the release group
docs/                     contracts (api.md, data-provider.md), this file, HANDOFF.md
docs/briefs/              the original briefs, verbatim (historical; CLAUDE.md wins)
references/               gitignored, read-only prior art
```

A package's folder is its npm name without the `@trivia/` scope; a crate's is its crate
name. The designer reaches the dev service over HTTP. The Vite and Next hosts use the shared
service and stamping code, and the service reaches the Rust engine through napi.
contract-sync writes files the engine's `bindQuery` and the designer read (`trivia.manifest.json`).

Every folder above with a `package.json` or a `project.json` is an Nx project, named without
the scope (`engine`, `oxc-engine`, `plugin`, …; `pnpm graph` draws them). A new library is
`nx g @trivia/tools:package <name>`. The crates without a `package.json` (`trivia_oxc_engine`,
`trivia_shell`) and `e2e/` describe their Cargo and Playwright targets in `project.json`.

## Designer: app → features → shared

```
packages/designer/
  server/        Node code for the designer's own dev server (the engine API guard)
  src/
    app/         composition root: entry, shell, connect screen
    features/    one folder per feature; its index.ts is its public API
    shared/      what any feature may use; it knows no feature
```

Rules, enforced by `packages/designer/src/architecture.test.ts`:

1. Imports point down the list: `app` → `features` → `shared`. `shared` never imports a
   feature or the app.
2. A feature never imports another feature. When two features need to talk, the contract
   goes in `shared/` and each side depends on it. Two examples exist: `shared/canvas.ts` (the
   canvas installs it, the inspector and commands call it) and `shared/template.ts` (the
   palette produces it, the canvas drops it).
3. The app reaches a feature only through `@/features/<name>` (its `index.ts`).
4. Inside a feature, imports are relative; across layers, they use `@/…`.

Where a new file goes:

- Used by one feature: inside that feature, even if it looks general (`features/inspector/
  tailwind/` is the inspector's). Move it to `shared/` when a second feature needs it.
- A new panel, drawer or tool (the Data Explorer, say): a new `features/<name>/` with an
  `index.ts`, mounted in `app/` (`features/layers` and `features/pages` are tabs of
  `app/LeftPanel.tsx`). What a feature needs from the canvas goes through `shared/canvas.ts`
  (the layers panel moves elements with `canvas.move`, the pages panel loads URLs with
  `canvas.navigate`).
- Engine API calls and types: `shared/engine/`. Store state and the action bus:
  `shared/state/`. Every write to user code goes through `dispatch` (`shared/state/actions.ts`).
- shadcn components: `shared/ui/` (components.json points `npx shadcn add` there). The
  palette and inspector read the **user's** `src/components/ui`, never these.
- Unit tests sit next to their code (`*.test.ts[x]`); a slice's test helpers and fixtures stay
  in the slice.

## Engine: ops are slices

```
crates/trivia_oxc_engine/src/
  lib.rs           parse, annotate, re-exports
  error.rs         EngineError and its stable codes
  locator.rs       the one locator algorithm (CLAUDE.md rule 3), JsxTable
  text.rs          byte-range edits and line/indent helpers
  import_manager.rs  derived imports (rule 9)
  workspace.rs     paths under the root, atomic and guarded writes (the only I/O)
  inspect.rs       read: node details for the inspector
  prop_analyzer.rs read: prop schemas from the user's components (rule 8)
  values.rs        read: value paths into object/array literals and method chains
  mentions.rs      read: where a file still names a field (member, string, key)
  ops/
    mod.rs         Op, Placement, Outcome, apply_op, and what every op shares
    insert.rs      insert, insertChild (and the snippet limits)
    update_prop.rs updateProp
    remove.rs      remove
    move_node.rs   move, moveNode (and the scope check)
    bind_query.rs  bindQuery
    set_text.rs    setText
    move_across.rs move and moveNode between two files
    values.rs      insertElement, removeElement, moveElement, setProperty, removeProperty
    chains.rs      setCallArgument, insertCall, removeCall (one call of a method chain)
```

A new op (a cross-file move, say) is a new `ops/<op>.rs` plus its `Op` variant
and a `docs/api.md` example: `tests/errors.rs` pins one example per variant. Integration tests
stay in `tests/` (Cargo's convention); unit tests stay in their module.

## Node packages

- **trivia-inferencer** (`@trivia/openapi-inferencer`): React components an app renders in a
  route. They are thin over the plugin: the page, its module and eject all come from
  `/@trivia/api/refine/*`. Inline styles, and no runtime dependencies beyond the `react` and
  `@refinedev/core` peers. Its source is the package's entry in the workspace (the example
  compiles it); `publishConfig` points a published build at `dist`.
- **dev-service** (`@trivia/dev-service`) owns the HTTP and MCP handlers, caller guard, edit
  queue, undo history, selection, shared stamping and Refine adapter. A `DevHost` supplies the
  project paths, module resolution, routes and preview publishing. Both transports go through
  the same `EngineService`. The standalone server binds to IPv4 loopback.
- **vite-plugin-ast-locator** filters and stamps JSX before Vite transforms it, reads React
  Router and TanStack Router declarations, and publishes virtual preview modules. It mounts
  the shared service in Vite's middleware stack.
- **next** (`@trivia/next`) registers the shared stamp through a loader in development.
  `trivia-next dev` starts the app's Next.js CLI and the standalone service. Its host reads
  App Router files and publishes preview files. The designer proxies the API and MCP URLs to
  the service and the canvas and HMR to Next.js.
- **contract-sync** follows its pipeline (`sync.ts`): `adapters/` (where a spec comes from) →
  `spec/` (the raw contract) → `codegen/` (hey-api, and reading back what it wrote) →
  `manifest/` (classification, naming, the generator and the manifest types).
- Both keep tests in `test/`. Those tests drive the package from outside (a real server, the
  whole pipeline, the CLI), and the packages are built from `src/` alone.
