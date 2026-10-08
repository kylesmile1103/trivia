# Architecture: where code goes

Trivia is organized by **deployable at the top and by feature inside**. A feature such as
`bindQuery` spans three runtimes: Rust (the engine edits the file), Node (the plugin serves
it over HTTP) and the browser (the designer offers it). Those are separate build targets, so
the repo splits by package, and each package splits into vertical slices of its own.

```
crates/
  trivia_oxc_engine/      the engine: pure Rust library (I/O only in workspace.rs)
  trivia_napi/            its Node binding, npm package @trivia/engine
packages/
  vite-plugin-ast-locator/  dev-only Vite plugin: stamps locators, serves /@trivia/api
  designer/               the React designer, @trivia/designer
  contract-sync/          OpenAPI → hey-api code + trivia.manifest.json, @trivia/contract-sync
examples/playground/      the "user app" every manual and e2e check runs against
e2e/                      Playwright, across designer + plugin + engine + playground
docs/                     contracts (api.md, data-provider.md), this file, HANDOFF.md
docs/briefs/              the original briefs, verbatim (historical; CLAUDE.md wins)
references/               gitignored, read-only prior art
```

A package's folder is its npm name without the `@trivia/` scope; a crate's is its crate
name. Dependencies between packages go one way: designer → (HTTP) → plugin → (napi) →
engine. contract-sync writes files the engine's `bindQuery` and the designer read
(`trivia.manifest.json`); nothing imports it at runtime.

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
- A new panel, drawer or tool (the Data Explorer, a layers panel): a new `features/<name>/`
  with an `index.ts`, mounted in `app/App.tsx`.
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
  ops/
    mod.rs         Op, Placement, Outcome, apply_op, and what every op shares
    insert.rs      insert, insertChild (and the snippet limits)
    update_prop.rs updateProp
    remove.rs      remove
    move_node.rs   move, moveNode (and the scope check)
    bind_query.rs  bindQuery
```

A new op (editing JSX text, a cross-file move) is a new `ops/<op>.rs` plus its `Op` variant
and a `docs/api.md` example: `tests/errors.rs` pins one example per variant. Integration tests
stay in `tests/` (Cargo's convention); unit tests stay in their module.

## Node packages

- **vite-plugin-ast-locator** stays flat (`index.ts` composes `transform.ts`, the locator
  stamping, with `api.ts` + `history.ts` + `queue.ts`, the HTTP API). Split it into folders
  when a slice grows past a few files.
- **contract-sync** follows its pipeline (`sync.ts`): `adapters/` (where a spec comes from) →
  `spec/` (the raw contract) → `codegen/` (hey-api, and reading back what it wrote) →
  `manifest/` (classification, naming, the generator and the manifest types).
- Both keep tests in `test/`. Those tests drive the package from outside (a real server, the
  whole pipeline, the CLI), and the packages are built from `src/` alone.
