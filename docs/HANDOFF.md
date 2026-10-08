# Trivia — Agent Handoff

**Read this first in a new session**, then `CLAUDE.md` (the design rules; it wins on conflicts).
Last updated: 2026-10-08, at the end of the first build session (one lead, with multi-agent
"ultracode" swarms).

Briefs and contracts:
- `docs/spec.md`: the original brief.
- `docs/spec-data-provider.md`: the data-provider brief, with verified corrections at its top.
- `docs/api.md`: the engine HTTP contract.
- `docs/data-provider.md`: the contract-sync design and the `bindQuery` contract.

<!-- STATUS:BEGIN -->
## 1. Status (2026-10-08, end of session 1)

`main` is pushed to `origin` (git@github.com:kylesmile1103/trivia.git) after a full green gate. Every
commit's author and committer email is `kylesmile1103@gmail.com`; the history was rewritten once,
before the first push, and `.git/hooks/pre-push` refuses the work email.

All work is merged: 9 builder branches, review-fix round 1 (5 fixers) and round 2 (3 fixers). The
`swarm/*` branches are local leftovers. They were never pushed and still carry pre-rewrite SHAs, so
don't merge them again.

**Final gate on `main`:**
- `cargo test --workspace` 228/228 (16 suites); `cargo clippy --workspace --all-targets -D warnings` clean.
- plugin 68, designer 389, contract-sync 76 (vitest).
- napi crash suite 25/25 (`pnpm --filter @trivia/engine test`).
- `pnpm typecheck` clean; designer oxlint has 0 errors.
- Playwright 36/36, twice in a row (stable).
- **Claude in Chrome, validated by hand:**
  - the Step 3 flow: one attribute written, HMR without a reload, byte-identical undo;
  - drag-move followed by ⌘Z (the selection is dropped, not retargeted);
  - a click during an edit's HMR, which is deferred and selects;
  - no console errors.

  GIFs are in the user's `~/Downloads/trivia-*.gif`.

**Review:**
- An adversarial review of 4 lenses × 2 skeptics found 20 issues; 18 were confirmed.
- Every confirmed finding is fixed, each with a regression test that failed first. A fresh verifier
  re-ran the reviewer's original reproduction against every fix.
- Remaining residuals are in §7.

**Brief acceptance:**
- Step 1 (locators on every element of a Vite+shadcn app): met.
- Step 2 (engine tests: comments kept, Button injected into CardContent, auto-import, byte
  preservation): met.
- Step 3 (canvas → inspector → `variant=outline` on disk → HMR): met.

**Not built yet:**
- the designer Data Explorer and drag-to-bind;
- DataTable and AutoForm generation;
- the playground's `@tanstack/react-query` dependency and QueryClientProvider.

`contract-sync` and `bindQuery` exist and are tested; see `docs/data-provider.md`.
<!-- STATUS:END -->

## 2. Run and test

```sh
pnpm install
pnpm build:engine            # napi addon (crates/trivia_napi → .node + index.js; both gitignored)
pnpm build:plugin            # vite-plugin-ast-locator → dist (the playground imports the built plugin)
pnpm --filter playground dev                 # user app, http://localhost:5173 (plugin + engine API)
TRIVIA_TARGET=http://localhost:5173 pnpm --filter @trivia/designer dev
#   designer: http://localhost:4400/__trivia/ (proxies everything else to the target)

cargo test --workspace                       # engine + binding
cargo test -p trivia_oxc_engine --test roundtrip   # one suite (~15 s; exhaustive byte round-trips)
cargo clippy --workspace --all-targets -- -D warnings
pnpm typecheck                               # all TS packages
pnpm --filter @trivia/vite-plugin-ast-locator test
pnpm --filter @trivia/designer test          # vitest (unit)
pnpm --filter @trivia/contract-sync test     # runs hey-api codegen + real tsc on its output
pnpm exec playwright test                    # e2e: starts the playground + designer itself
TRIVIA_APP_PORT=5311 TRIVIA_PORT=4411 pnpm exec playwright test e2e/canvas.spec.ts   # other ports, one spec
```

E2E tests and manual checks edit `examples/playground/src/**` on disk. Restore afterwards with
`git checkout -- examples/` and check that `git status` is clean before committing.

## 3. How the pieces fit (one paragraph)

The user runs their own Vite app with `@trivia/vite-plugin-ast-locator`. In dev, the plugin
stamps every JSX opening tag with `data-ast-node="<file>#<component>#<i.j.k>"`, and it serves
`/@trivia/api/*` by calling the Rust engine through napi. The designer (`/__trivia/`) proxies
the app on the same origin. The canvas hit-tests the iframe DOM through an overlay, the
inspector edits props, the style panel edits Tailwind classes, and the palette inserts
components. Every change is one serializable `Op` (`insert`, `insertChild`, `updateProp`,
`remove`, `move`, `moveNode`, `bindQuery`) sent to the engine. The engine parses the file with
OXC, computes **byte-range edits** (it never reprints), re-parses the result, and writes the
file atomically. Vite's HMR then re-renders the canvas. Undo/redo restores guarded file
snapshots. The data-provider pipeline (`@trivia/contract-sync`) turns an OpenAPI/Swagger spec
into hey-api TanStack Query code and a deterministic `trivia.manifest.json`; `bindQuery`
writes `useQuery` hooks against it.

## 4. Decisions (and why)

| Decision | Why |
| --- | --- |
| Byte-range splicing, never `oxc_codegen` reprint | A probe showed Codegen reformats untouched code (adds `;`, uses tabs, drops parens). The product promise is byte preservation. |
| One locator algorithm, in Rust (`locator.rs`), used by both the plugin (`annotate`) and the ops | Two implementations would drift. Locators are positions, not identities. |
| Engine as a napi addon inside the Vite plugin (not Tauri, not wasm) | The plugin needs it in-process for `annotate`, and writes need the filesystem. The engine is a plain Rust library, so a Tauri shell can come later. |
| Designer proxies the user's dev server (same origin) | The canvas needs `iframe.contentDocument`. The user chose the proxy option. |
| `data-ast-node` injected as the *first* attribute | Usage-site `{...props}` then overrides the definition-site value inside shadcn wrappers, and the canvas climbs past locators in `uiDir` to the usage site. |
| Prop schemas from syntactic analysis of the user's `src/components/ui` | shadcn v4 has no `*Props` interfaces. Variants come from `cva(...)`, curated intrinsic props from `ComponentProps<"tag">`/Radix. OXC has no type checker. |
| Undo = guarded before/after file snapshots (not inverse ops) | Byte-exact. It refuses with 409 `conflict` if the file changed elsewhere. |
| Two-phase editing (Onlook): preview real CSS during a gesture, write Tailwind classes on commit | Tailwind JIT has no CSS for classes that aren't in the source yet. |
| Data provider: OpenAPI → hey-api 0.99.0 (pinned) → `useQuery`; static manifest; zero proprietary runtime | Rejects `@tangojs/boot` and Refine's runtime. The generated client is bundled, so the only runtime dependency is `@tanstack/react-query`. |
| pnpm workspace; package names `trivia_*` / `@trivia/*` | The user renamed `tango_*` to `trivia_*`. |

## 5. Catches: code and product

- **OXC 0.153 API ≠ the briefs.** `Codegen` (not `CodeGenerator`), `.code`, no `preserve_parens`,
  `ParserReturn.fatal_error`, exports split into `ExportDeclaration` / `ExportNamedDeclaration`
  / `ExportFromDeclaration`, and `BindingPattern` is an enum. See CLAUDE.md for the full list.
- **Spans are UTF-8 bytes in Rust and UTF-16 in JS.** `annotate_utf16` converts for the plugin.
  Never mix the two.
- **CRLF:** line-end helpers must not insert between `\r` and `\n`. There is a regression test
  for this, and every round-trip sweep also runs on CRLF copies.
- **Locators are positions.** After any structural edit, use the locator returned by the op.
  The designer guards undo/redo (it drops a selection whose tag changed) and sends
  `expectedName` / `expectedTargetName` / `expectedParentName` so stale locators fail with 409.
- **Moves must keep identifier scope.** Moving JSX out of a `.map` callback, or between
  components, is refused unless every identifier still resolves to the same symbol (review
  finding).
- **shadcn now imports `cn` from the npm package `"cn"`,** not `@/lib/utils`. That's real, not a
  CLI bug.
- **hey-api gotchas.** It `rm -rf`s its output dir and deep-merges `openapi-ts.config.*` from
  cwd. contract-sync stages into a sibling dir and passes an empty config file.
  `@hey-api/openapi-ts` 0.99 declares node ≥ 22.18; this machine runs 22.16 (it works, with a
  warning).
- **PostgREST (Supabase)** serves Swagger 2.0 with no `/{id}` paths. Rows are selected with
  `eq.` filters (see `docs/data-provider.md`).
- **The Rust toolchain differs across shells:** 1.97.1 in some shells, 1.99 in others. Both
  work; OXC needs ≥ 1.97.

## 6. Catches: process and environment (learned the hard way)

- **Run `Workflow` with worktree isolation only from the repo root.** Isolation branches the
  repo of the shell's *cwd*. One run from `references/openapi-ts` gave agents worktrees of the
  wrong repo.
- **Never `SendMessage` a *running* workflow agent.** It doesn't reach the running agent; it
  starts a second, resumed copy that edits the same worktree. If it happens, `TaskStop(agentId)`
  stops the copy only. Pass new instructions in the next phase instead.
- **Usage limits kill agents mid-task.** Save their partial work as a WIP commit on their
  branch, free the worktree, and start a fresh agent that continues from the branch (a workflow
  agent can't be resumed).
- **Review/probe agents touched the lead's live dev server** despite read-only instructions:
  they POSTed to `/@trivia/api` on :5173 and edited `Dashboard.tsx`. Run reviews against servers
  on their own ports, or stop yours, and check `git status` after.
- **Claude in Chrome** is the tool for UI validation (user preference). If the Chrome
  window/tab is backgrounded (`document.visibilityState === "hidden"`), mouse presses aren't
  delivered and timers are throttled. Ask the user to bring the window to the front rather than
  diagnosing phantom bugs. A real `PointerEvent` dispatched in-page is the control experiment.
- **Commit identity:** `kylesmile1103@gmail.com`, in the repo-local git config. The global
  config holds a work email that must never reach the remote. `.git/hooks/pre-commit` and
  `pre-push` enforce this (case-insensitive). Never use `--no-verify`.
- **Selecting a Chrome browser:** if clicks don't register, run `/chrome` to pick the right browser (a backgrounded or other browser drops presses). After HMR, `import()`-ing a module in the page gives a fresh copy, so trust screenshots.
- **Probing agents write to live servers.** Stop your dev servers, or keep them on ports no agent knows, while review or verify agents run, and check `git status` afterwards.
- **Re-run the *whole* suite after touching docs.** `errors.rs` pins one `docs/api.md` example
  per `Op` variant.

## 7. Backlog / next steps (in priority order)

1. Round-2 verifier residuals:
   - A user file with 50k+ nested elements grows RSS past 6 GB in inspect/applyOps. Cap file size or
     depth before parsing.
   - The designer proxy dies on a malformed request target (`GET /\%40x/y` from http-proxy-3). Catch it.
   - A deferred click can select a different element after the layout shifts (accepted trade-off).
   - `applyAfterLeaving` bypasses the action bus's in-flight counter.
   - `api-guard.test.ts` is not covered by `pnpm typecheck` (`tsconfig.node.json`).
2. Data provider, designer side: a Data Explorer drawer (manifest tree, operations, schema) plus
   drag-to-bind using `bindQuery`; generate the DataTable component, its columns, and forms; add
   `@tanstack/react-query` and a QueryClientProvider to the playground; contract drift badges.
3. An engine op for editing JSX text; cross-file move; `canvas.fitZoom`; a layers panel.
4. A Tauri shell (the engine is already a plain Rust library).

## 8. Repo map

- `crates/trivia_oxc_engine/src/`
  - `locator.rs`: locators and `annotate`.
  - `mutator.rs`: `Op` and edits.
  - `import_manager.rs`, `text.rs` (edit and line helpers), `inspect.rs`, `workspace.rs`
    (paths, atomic and guarded writes).
  - `prop_analyzer.rs`, `data_binder.rs`.
- `crates/trivia_napi/`: the napi binding (JSON envelope API) and package `@trivia/engine`.
- `packages/vite-plugin-ast-locator/src/`: `transform.ts` (locators), `api.ts` (HTTP),
  `history.ts` (undo), `options.ts` (uiDir/importBase from `components.json`).
- `packages/trivia-designer/src/`:
  - `canvas/` (overlay, hit testing, drop zones, previews), `inspector/` (props, class manager,
    `style/` panel);
  - `registry/` (palette and templates), `toolbar/`, `state/` (zustand store and action bus),
    `bridge/` (API client and TS types mirroring Rust serde), `lib/tailwind/` (CSS→Tailwind).
- `packages/trivia-contract-sync/`: hey-api codegen, the manifest generator, and REST/Supabase
  adapters.
- `examples/playground/`: a stock create-vite + shadcn (radix, nova) user app.
- `e2e/*.spec.ts`: Playwright (`playwright.config.ts`, ports come from env).
- `references/` (gitignored, read-only): tango, oxc, oxbox, openapi-ts, onlook, refine.
