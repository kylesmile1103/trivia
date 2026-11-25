# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **New session? Start with `docs/HANDOFF.md`.** It covers the current status, the decisions, the catches, and the prioritized backlog.
> **What the product is for** (who, which jobs, in what order) is `docs/product.md`.

## What Trivia is

A local-first visual React UI builder: a port of NetEase Tango's idea (edit the real source AST, no DSL)
onto Rust/OXC + a native Vite dev server + un-wrapped shadcn/ui. In compiler terms *trivia* is the
whitespace and comments a normal AST round-trip throws away — **byte-preserving edits are the product**,
not a nice-to-have.

The original brief is `docs/briefs/spec.md` (verbatim). Where it conflicts with this file, this file wins:
the sections below record what was verified against the reference code on 2026-10-07.

## Layout and commands

- `crates/trivia_oxc_engine` — the engine (pure Rust, no I/O except `workspace.rs`).
- `crates/trivia_napi` — napi-rs binding, npm package `@trivia/engine` (JSON envelope API).
- `packages/vite-plugin-ast-locator` — dev-only Vite host that injects `data-ast-node` and
  mounts the dev service in Vite.
- `packages/dev-service` — shared stamping, engine HTTP API (`docs/api.md`), MCP (`docs/mcp.md`),
  edit history and Refine adapter. The standalone server listens on `127.0.0.1`.
- `packages/next` (`@trivia/next`) — Next.js App Router host, development loader, `withTrivia` and
  `trivia-next dev`.
- `packages/designer` — React designer (`@trivia/designer`), served at
  `http://localhost:4400/__trivia/`; proxies everything else to the user's dev server.
- `packages/contract-sync` — OpenAPI → hey-api TanStack Query code + `trivia.manifest.json`
  (`docs/data-provider.md`).
- `packages/trivia-inferencer` — `@trivia/openapi-inferencer`, the drop-in contract-driven
  replacement for Refine's inferencer (`docs/product.md`, slice 6).
- `examples/playground` — a stock create-vite + shadcn (radix, nova) app used as the "user app".
- `examples/refine-admin` — a Refine + shadcn back office on an OpenAPI mock: the user app for
  the product direction in `docs/product.md` (day 2 for Refine apps on OpenAPI backends).
- `examples/next-admin` — the Refine example on App Router, with server and client edit coverage.
- `e2e/` — Playwright across all of the above.
- `tools/` — `@trivia/tools`: the package generator (`nx g @trivia/tools:package <name>`) and
  the release helpers (`tools/release/`, run by `pnpm release`). Plain CommonJS: Nx loads `.ts`
  there only through swc/ts-node on Node 22.16.

Nx 23.2.1 runs the tasks (`nx.json`). Each package's `package.json` scripts stay the source of
truth, and Nx adds caching, `dependsOn: ["^build"]` and long-running `dev` targets. Projects have
short names (`nx.name`): `engine`, `oxc-engine`, `plugin`, `dev-service`, `next`, `contract-sync`,
`inferencer`, `designer`, `playground`, `refine-admin`, `next-admin`, `shell`, `e2e`, `tools`. A test's cache key includes
`examples/**` and `docs/**` (the suites read them). When a test starts reading another file
outside its project, add it to that input, or the cache serves a stale pass.

Where code goes is in `docs/architecture.md`: packages at the top, feature slices inside.
The designer is `app/` → `features/<name>/` (public API in `index.ts`) → `shared/`. A feature
never imports another feature, and `src/architecture.test.ts` enforces that. Engine write ops
are one module each under `crates/trivia_oxc_engine/src/ops/`.

```sh
pnpm dev                                              # refine-admin :5173 + designer :4400/__trivia/
pnpm dev:playground                                   # playground :5173 + designer (dev:desktop adds the window)
pnpm check                                            # build, typecheck, lint, test: every project, cached
pnpm affected                                         # the same for what changed; pnpm e2e for Playwright
nx test oxc-engine                                    # one project's target (nx = pnpm exec nx)
cargo test -p trivia_oxc_engine --test acceptance move_  # one test (name filter)
pnpm release 0.2.0 --dry-run                          # versions, CHANGELOG.md, tag, GitHub release
```

Commit messages start with their area, `<area>: <what changed>` (`engine:`, `plugin:`,
`designer:`, `MCP:`, `docs:`, `repo:`). The changelog groups by it, and `pnpm release` refuses
an area missing from `release.conventionalCommits.types` in `nx.json`.

Toolchain: rustc/cargo 1.99.0, node 22.16, pnpm 12.9 (workspace root). OXC 0.153 needs rust ≥ 1.97.

## Reference repos (`references/`, gitignored, read-only)

Shallow clones (`--depth 1`; `git -C references/<repo> fetch --unshallow` for history). Treat them as
read-only research material — don't build or run tooling from inside them.

- `tango/` — the system being replaced. Prior art map below.
- `onlook/` — a modern visual React editor (Babel + Prettier, cloud stack). Verified notes below.
- `oxc/` — OXC at 0.153.0. Check API names here before writing engine code; the API moves fast
  (see Spec corrections).
- `oxbox/` — template for shipping a Rust/OXC engine as **one wasm usable from Node and the browser**:
  napi-rs targeting `wasm32-wasip1-threads` (`rust/.cargo/config.toml`), a custom tiny N-API host
  (`src/napi.ts`) instead of emnapi, and the wasm embedded in JS (`scripts/vendor.ts`). Limits:
  its host doesn't implement the number/buffer N-API calls (keep the API string/JSON in and out, or
  extend `napi.ts`); its threads need `SharedArrayBuffer`, so the page must be cross-origin isolated;
  it pins oxc 0.151.0.
- `openapi-ts/` — monorepo scaffold (pnpm workspaces + turbo, Vitest projects, tsdown,
  oxlint/oxfmt, strict `tsconfig.base.json`). Its task runner is not ours: the user chose Nx
  (2026-10-09). The design to borrow is in
  `packages/codegen-core/src/planner/planner.ts` (`planImports`, ~line 282): imports are *derived
  from symbol references*, never hand-edited. Its own CLAUDE.md pins versions that are already stale.

## Architecture: the edit loop

```
user's Vite app (real files on disk)
  └─ vite-plugin-ast-locator (dev only) stamps every JSX opening tag: data-ast-node="<locator>"
designer (React) ── <iframe src=dev server> + transparent overlay on top
  hover/click → elementsFromPoint → nearest [data-ast-node] → bbox drawn on overlay
  inspector ← prop schemas from engine's prop analyzer (reads the user's src/components/ui/*.tsx)
  edit → engine op {file, locator, op, args}
engine (Rust/OXC) → parse fresh from disk → resolve locator → compute byte-range edits
  → atomic write (temp file + rename) → Vite HMR → canvas re-renders → designer re-resolves selection
```

Locator format (canonical): `<relative_path>#<component_or_export_name>#<index_path>`, e.g.
`src/pages/Dashboard.tsx#Dashboard#0.1.3`. Part 2 of the brief also shows `file.tsx:line:col:nodeIndex`;
that's an earlier draft — don't use it.

The designer's own UI uses shadcn, and so does the user's project. They are separate installs. The
component palette and prop schemas come from the **user's** `src/components/ui/`, never the designer's.

## Load-bearing design rules (verified; override the brief)

1. **Edits are span splices, never whole-file reprints.** Re-printing with `oxc_codegen` changes
   untouched code. A probe at 0.153.0 showed it adds `;`, converts indentation to tabs and drops the
   parentheses in `return ( … )`. Its docs say "At present, only some leading comments are preserved"
   (`references/oxc/crates/oxc_codegen/src/options.rs`). So: parse with OXC only to find spans, then
   apply insert/replace/delete byte ranges to the original text. Generate text only for the new
   fragment (an attribute, an element, an import line) and indent it to match the surrounding line.
   Re-parse the result and refuse to write if it has diagnostics. The core test assertion is
   byte-for-byte equality outside the edited ranges.
2. **Offsets: Rust spans are UTF-8 bytes; `oxc-parser` on npm converts them to UTF-16**
   (`references/oxc/napi/parser/src/lib.rs`, `convert_utf8_to_utf16`). Never pass an offset across the
   JS↔Rust boundary without stating which unit it is in.
3. **One locator algorithm.** The plugin (computing at transform time) and the engine (resolving at
   edit time) must produce identical index paths for the same source. Implement it once (Rust, exposed
   to Node), or keep a shared fixture suite that both implementations must pass. Pin down before Phase 1:
   which `JSXChild` kinds count toward an index (`Text`/`Element`/`Fragment`/`ExpressionContainer`/
   `Spread`) — whitespace-only `JSXText` must never count, or reformatting shifts every index. Also
   define elements inside `{cond && …}` / `.map()`, multiple `return`s, several components per file,
   anonymous default exports, and fragments (`<>` can't carry an attribute but may hold an index).
4. **Locators are positions, not identities.** Any structural edit shifts later siblings, and so does a
   hand edit in the user's IDE. Every op carries the expected element name (e.g. `Button`), and the
   engine fails loudly if the locator now resolves to something else. After HMR the designer re-reads
   locators from the DOM; it doesn't patch them.
5. **Inject `data-ast-node` as the *first* attribute.** In JSX, later attributes and spreads win. The
   plugin also annotates `src/components/ui/button.tsx` itself, but there `<Comp … {...props}/>`
   receives the usage-site `data-ast-node` through `props`, which overrides the definition-site one.
   That way the DOM points at the user's `<Button>`, not at shadcn internals. Tango does the same
   (`references/tango/packages/core/src/helpers/ast/traverse.ts` ~1305). When a component doesn't spread
   props, the DOM node keeps a definition-site locator. The designer must handle that (for example by
   walking up to the nearest usage-site ancestor).
6. **The plugin must see JSX before it is compiled away:** `enforce: 'pre'`, `apply: 'serve'`, skip
   `node_modules`, and return a source map.
7. **`iframe.contentDocument` needs the same origin.** A designer on a different port from the user's
   dev server gets `null`. Tango worked only because it was same-origin
   (`references/tango/packages/designer/src/dnd/dnd-query.ts:45-52`). Choosing how to stay same-origin
   is an open decision; see below.
8. **Prop schemas cannot come from `*Props` interfaces.** Current shadcn (`new-york-v4/ui/button.tsx`,
   fetched 2026-10-07) has no `ButtonProps`. Props are inline on the function parameter:
   `React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }`.
   OXC has no type checker, so the analyzer must:
   - read the parameter's type annotation;
   - resolve `VariantProps<typeof X>` syntactically, by finding `X = cva(…)` and reading the keys of
     its `variants` object (unions) and its `defaultVariants` (defaults; parameter destructuring
     defaults also carry them);
   - not try to expand `React.ComponentProps<"tag">` syntactically — use a curated list (`className`,
     `disabled`, `placeholder`, …) or the TS compiler API.

   shadcn v4 also stamps `data-slot="<name>"` on rendered DOM, which helps identify components.
9. **Imports are derived, and only for names the op touched.** After insert/remove, compare the JSX
   component references (via `oxc_semantic`) with the existing imports. Add or merge the specifier for an
   inserted component. Drop a specifier only when the op removed that name's last reference. Never prune
   other unused imports: that's an unrequested edit to user code. Take the import path from the project
   (shadcn's `components.json` aliases) instead of hardcoding `@/components/ui/<name>`. Note: Tango's
   remove never cleaned imports (`removeUnusedImportSpecifiers` runs only under `autoFormatCode`).

## Spec corrections — OXC 0.153.0 API (the brief's snippets won't compile)

- `CodeGenerator` is now `Codegen`. Its result field is `.code`, not `.source_text`. `CodegenOptions` has
  **no `preserve_parens`**. Its fields are `single_quote, minify, ascii_only, comments, source_map_path,
  indent_char (default Tab), indent_width, initial_indent`.
- `ParserReturn` has `diagnostics` (not `errors`) and `fatal_error` (not `panicked`). Check both.
- Exports are split: `export function X` / `export const X` → `Statement::ExportDeclaration
  { declaration }`; `export { a }` → `ExportNamedDeclaration { specifiers }`; re-exports →
  `ExportFromDeclaration`. `BindingPattern` is an enum (type annotations live on
  `FormalParameter` / `VariableDeclarator`).
- `SourceType::from_path("x.tsx")` already enables TS + JSX, so `.with_typescript/.with_jsx` aren't
  needed.
- `JSXElement { opening_element, children: Vec<JSXChild>, closing_element: Option<…>, span }`. Every
  node has a `span` (`u32` byte offsets) and the program keeps `comments: Vec<Comment>`. New nodes go
  through `oxc_ast::AstBuilder`, but under rule 1 you usually generate text rather than build nodes.
- Pin every OXC crate to one exact version (`=0.153.0`). If you also use the npm `oxc-parser`, pin the
  same version.

## Tango prior art (where to look, what not to copy)

Paths are relative to `references/tango/packages/`.

- Node identity: `data-dnd` = `<file>:<Component>:<camelName><counter>`
  (`core/src/helpers/id-generator.ts`). It is written into the AST itself, not by a Babel plugin, and is
  unstable across hand edits. Our positional locator replaces it.
- Mutations: `core/src/helpers/ast/traverse.ts`: `appendChildToJSXElement`,
  `insertSibling{Before,After}JSXElement` (wraps in a Fragment inside an expression container),
  `removeJSXElement`, `updateJSXAttributes`. A move is clone + insert + remove
  (`core/src/models/abstract-workspace.ts` `dropNode`).
- Printing: `@babel/generator` plus Prettier (`core/src/helpers/ast/generate.ts`). This is exactly the
  formatting loss Trivia exists to fix. Its parser config has no TypeScript plugin.
- Drop zones: `designer/src/dnd/use-dnd.ts` (~194-357). Nearest child by rect distance, then
  before/after by midpoint (X axis for inline display, Y for block), and insert-inside for empty
  containers. Worth porting.
- Selection boxes: `getBoundingClientRect` minus the container rect (`designer/src/helpers/dom.ts`),
  recomputed on resize/scroll/sandbox-ready. Hit-testing uses event target + `closest('[data-dnd]')`.
- Prototype schema (the thing we replace with static analysis): `helpers/src/types/prototype.ts`.
  Setters are chosen by explicit name, not inferred from types.

## Decisions (2026-10-07)

- **Naming:** `tango_*` from the brief became `trivia_*`.
- **Engine host:** native napi-rs addon loaded by the Vite plugin (the plugin needs it in-process
  for `annotate`, which keeps one locator implementation). The engine stays a plain Rust library,
  so a Tauri shell can wrap the same designer later without engine changes.
- **Same origin:** the designer's dev server proxies the user's dev server (HTTP + WebSocket);
  the designer itself lives under `/__trivia/` (`packages/designer/vite.config.ts`).
- **Package manager:** pnpm workspace.
- **Task runner (2026-10-09):** Nx 23.2.1 over the existing scripts, chosen by the user over
  Turborepo. One tool covers cached tasks, `pnpm dev` (continuous targets), the project graph,
  generators and releases. Local only: `neverConnectToCloud`, `analytics: false`, no daemon.
  pnpm denies nx's install script (`allowBuilds`), which only updates the Nx Cloud client.
- **Releases (2026-10-09):** one fixed version for every package and crate, tag `v{version}`,
  current version from the git tag. `tools/release/version-actions.cjs` edits each version in
  place (`package.json`, `Cargo.toml`, `tauri.conf.json`, `Cargo.lock`) instead of
  `@monodon/rust`, which re-serializes `Cargo.toml` and needs Nx 22. Nothing is published to npm
  (`--skip-publish`). `createRelease` makes Nx push the release commit and tag. Then
  `tools/release/desktop.mjs` bundles the Tauri app (`nx run shell:bundle`, CLI 2.11.5) and
  attaches its .dmg: ad-hoc signed (no Developer ID), Apple silicon, so releases run on a Mac.
  Tests never repeat a package's version: they read its `package.json` (a release bumps it;
  v0.2.0 broke three tests that said "0.1.0").

## Onlook (`references/onlook`) — verified 2026-10-07

Worth adopting:
- **Two-phase editing.** Preview live in the iframe during gestures and write source on commit
  (mouseup/blur/enter). Onlook uses one override stylesheet (`<style id="onlook-stylesheet">`,
  `apps/web/preload/script/api/style/css-manager.ts`) plus gesture transactions that merge into
  one history entry (`apps/web/client/src/components/store/editor/history/`).
  Tailwind JIT has CSS only for classes already in source, so previews of new values must be
  real CSS. Commit converts it to classes.
- **One serializable action vocabulary** with undo/redo (`packages/models/src/actions/action.ts`).
  Ours is `Op` (`ops/mod.rs`), shared by designer and agents. Undo is a guarded before/after file
  restore (byte-exact) instead of inverse actions.
- **CSS→Tailwind, then `twMerge`** (`packages/utility/src/tailwind.ts`, `tw-merge.ts`).

Not to copy:
- persisting random `data-oid` ids into user source;
- Babel + Prettier reformatting the whole file on every write;
- penpal with `allowedOrigins: '*'`.

The pasted analysis said Onlook selects component boundaries and defers all writes. The code
shows otherwise: it selects the deepest element and writes immediately outside transactions.
