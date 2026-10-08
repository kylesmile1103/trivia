# Trivia — Agent Handoff

**Read this first in a new session**, then `CLAUDE.md` (the design rules; it wins on conflicts).
Last updated: 2026-10-08, at the end of session 2 (one lead, no swarms): the round-2 residuals
are fixed and the codebase is reorganized into feature slices.

Briefs and contracts:
- `docs/architecture.md`: where code goes (packages at the top, feature slices inside).
- `docs/briefs/spec.md`: the original brief.
- `docs/briefs/data-provider.md`: the data-provider brief, with verified corrections at its top.
- `docs/api.md`: the engine HTTP contract.
- `docs/mcp.md`: the MCP endpoint for agents (point and ask).
- `docs/data-provider.md`: the contract-sync design and the `bindQuery` contract.

<!-- STATUS:BEGIN -->
## 1. Status (2026-10-09, session 3)

`main` is pushed to `origin` (github.com/kylesmile1103/trivia), including the setText op, the
MCP endpoint, the designer's selection sync and their docs. Every commit email is `kylesmile1103@gmail.com`;
`.git/hooks/pre-commit` and `pre-push` refuse the work email. Session 1's leftover `swarm/*`
and `worktree-wf_*` branches were deleted; each tip's tree was in `origin/main`'s history.

**Session 2:**
- **Round-2 residuals fixed**, each with a regression test that failed first:
  - Deep files: locators grow with the square of nesting (50 000 nested elements took over
    6 GB). Every entry point now refuses a file whose locators would pass 2^22 segments:
    422 `unsupported`, and the plugin serves it without locators. Measured: 117 MB at 50 000
    levels, and the napi crash suite now bounds every case's peak RSS at 512 MiB.
  - The designer answers 400 to a request target its proxy can't parse (`GET /\%40x/y` used to
    kill the dev server).
  - Leave-commits go through the action bus (`dispatch(op, label, { follow: false })`).
  - `pnpm typecheck` covers `server/api-guard.test.ts`.
  - Left as is: a deferred click can select a different element after the layout shifts (an
    accepted trade-off).
- **Reorganized** (`docs/architecture.md`):
  - package folders follow npm names (`packages/designer`, `packages/contract-sync`);
  - the designer is `app/` → `features/{canvas,inspector,palette,toolbar}/` → `shared/`,
    enforced by `src/architecture.test.ts`;
  - engine write ops are one module each in `src/ops/`;
  - contract-sync is grouped by pipeline stage, the plugin into `api/` and `mcp/`;
  - briefs are in `docs/briefs/`.

  Git recorded the moves as renames: `git log --follow` works.
- **Milestone: agents can build with Trivia** (`docs/mcp.md`). The user chose point and ask:
  - the plugin serves MCP at `/@trivia/mcp` (Streamable HTTP, stateless, the official SDK
    pinned at 1.30.1);
  - five tools: get_selection, inspect, list_components, apply (every guard required, one
    `Agent: …` undo entry), and undo (only the named entry);
  - the designer publishes its selection, and an agent's edit moves it with its element;
  - a new engine op, `setText`.

  `e2e/mcp.spec.ts` runs the whole loop in a browser. The designer proxy's guard now also
  covers `/@trivia/mcp`; a test showed a LAN client could reach it before.
- **Roadmap review** (the user's draft of five tracks):
  - Track 1 (the trivia-preservation spike) was already answered in session 1: rule 1.
  - Track 3 (a postMessage bridge) is dropped: same-origin direct access already does it.
  - Track 4: drift is handled; a git-dirty guard comes with the first multi-file generator.
  - Track 2 (forms with zod + react-hook-form + shadcn `Field`, which replaces the deprecated
    `Form`) is the next product milestone.

**Session 3** (the user asked to clear the backlog; each item was gated, committed and pushed):
- Designer: a right-click menu on the canvas (structure edits), zoom to fit (⇧1), a Layers
  panel (`features/layers`, from `trivia_outline`'s tree), and moving elements between files
  (engine `ops/move_across.rs`: imports come along, a reference that can't is refused).
- Engine: `createFile` (with `ifMissing`), history entries that create or delete files, and
  the CustomerCard preservation case pinned as a fixture.
- Data UI (Track 2): contract-sync `--zod` and request-body fields; a customers API in the
  playground (`mock-api.ts`); `GET /manifest` with drift; the designer's **Data** tab inserts a
  table bound to a list query, or a create form (react-hook-form + zodResolver + shadcn
  `Field`) from the API contract (`docs/data-provider.md`).
- MCP: `trivia_outline`, `bindQuery` for agents, `trivia_sync_openapi` (refused over
  uncommitted generated code unless `force`) and `trivia_screenshot`: the open designer
  captures its canvas with `html-to-image` over a long poll. A closed designer tab's
  long-poll used to take requests and never answer; dropped on hang-up, with a test.
- **Point and ask, tried with a real Claude Code session** (`claude -p`, only the Trivia
  server; `docs/mcp.md` has the prompts and what the agent did). Fixed what it tripped on:
  Claude Code shows the model `structuredContent`, not the text summary, so hints are now
  data fields; `trivia_get_selection` returns the undo history (a fresh session couldn't
  undo); error advice is per tool; sync says whether the contract changed.
- **Product reset** (`docs/product.md`). With the user, after a market scan: Trivia is the
  contract-aware day-2 tool for **Refine + shadcn apps on OpenAPI backends** (internal tools).
  Their weekly jobs, in order: columns, form fields, contract drift, new resources. General
  editor features are frozen. **Slice 1 (columns) is done:**
  - value paths and value ops in the engine;
  - a Refine adapter in the plugin, with HTTP and MCP;
  - a Columns panel in the Data tab;
  - `examples/refine-admin` with its own e2e project.

  **Slice 2 (form fields) is done too:** a create/edit form's zod rule, default and
  Controller are kept in step, from the request body. **Slice 3 (contract drift):** after a spec
  change, the Data tab (and `trivia_contract_drift`) lists each page's broken references, with a
  fix each, and offers Sync. **Slice 4 (new resource):** a contract resource's missing list,
  create, edit and show pages, registered in `<Refine resources>` and routed, as one undo entry.

  **Slice 5 (forms that survive real code)** came from the user's form-compiler idea. Assessed
  with them, OpenAPI stayed the input:
  - the engine follows method chains (`z.object({…}).refine(…)`) and edits one call in place
    (chain ops);
  - the manifest carries bounds, and drift compares rules against them with an in-place fix;
  - Refine's `<FormField>` style is read and written;
  - new fields go by contract order inside the developer's wrappers;
  - a removed field's other mentions are listed.

  **Slice 6 (drop-in inferencer)** came from the user's `@trivia/openapi-inferencer` idea.
  `packages/trivia-inferencer` renders a contract page live in a route, before any file
  exists, and Eject writes it and swaps itself out through the new engine op `replaceElement`.
  It is a thin layer on slice 4's generator. The preview *is* the generated code, served by the
  plugin as a module (`/@trivia/preview/<id>.tsx`), plus a Tailwind stylesheet for its classes.

  The user was away for the slice-1/2, slice-5 and slice-6 design calls; they are marked ⚑ in
  `product.md` for review.
- **Desktop shell** (`crates/trivia_shell`, Tauri 2.11.6, its own Cargo workspace): a window
  on the designer, with a waiting page until it answers. Verified on macOS by an agent's
  screenshot from the minimized window. That check found a screenshot bug browsers have too:
  html-to-image waited for an animation frame, which a background tab never gets. The
  designer now rasterizes the SVG itself (`features/canvas/capture.ts`).

**Gate on `main` (all green):**
- `cargo test --workspace` 286 passed; clippy `-D warnings` clean. The shell: 5 tests, clippy clean.
- Vitest: plugin 158, designer 445 (including 6 architecture rules), contract-sync 80, inferencer 8.
- napi crash suite 41/41, with RSS bounds (now including `describeValues` and `mentions`).
- `pnpm typecheck` clean; designer oxlint has 0 errors.
- Playwright 54/54 (playground and refine projects).
- Not re-done in sessions 2–3: the Claude in Chrome manual pass. Session 1's is described below,
  and Playwright covers the same flows.

**Brief acceptance:** Steps 1–3 were met in session 1 (validated by hand in Chrome; GIFs in
the user's `~/Downloads/trivia-*.gif`).

**Not built yet:**
- edit forms (an update body plus loading the row) and nested-object fields in generated forms.

`contract-sync` and `bindQuery` exist and are tested; see `docs/data-provider.md`.
<!-- STATUS:END -->

## 2. Run and test

```sh
pnpm install
pnpm build:engine            # napi addon (crates/trivia_napi → .node + index.js; both gitignored)
pnpm build:plugin            # vite-plugin-ast-locator → dist (the playground imports the built plugin)
pnpm --filter playground dev                 # user app, http://localhost:5173 (plugin + engine API)
pnpm --filter refine-admin dev               # or the Refine example (docs/product.md), same port
TRIVIA_TARGET=http://localhost:5173 pnpm --filter @trivia/designer dev
#   designer: http://localhost:4400/__trivia/ (proxies everything else to the target)

cargo test --workspace                       # engine + binding
cargo test -p trivia_oxc_engine --test roundtrip   # one suite (~15 s; exhaustive byte round-trips)
cargo clippy --workspace --all-targets -- -D warnings
cargo test --manifest-path crates/trivia_shell/Cargo.toml   # the desktop shell (its own workspace)
cargo run --manifest-path crates/trivia_shell/Cargo.toml    # a window on the designer (:4400)
pnpm typecheck                               # all TS packages
pnpm --filter @trivia/vite-plugin-ast-locator test
pnpm --filter @trivia/designer test          # vitest (unit)
pnpm --filter @trivia/contract-sync test     # runs hey-api codegen + real tsc on its output
pnpm exec playwright test                    # e2e: starts the playground + designer itself
TRIVIA_APP_PORT=5311 TRIVIA_PORT=4411 pnpm exec playwright test e2e/canvas.spec.ts   # other ports, one spec
# Playwright runs two projects: playground (designer on TRIVIA_PORT) and refine (refine-admin on
# TRIVIA_REFINE_APP_PORT, its designer on TRIVIA_REFINE_PORT; defaults 5174/4401).
TRIVIA_APP_PORT=5311 TRIVIA_PORT=4411 TRIVIA_REFINE_APP_PORT=5312 TRIVIA_REFINE_PORT=4412 pnpm exec playwright test
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
| Packages by deployable at the top, feature slices inside (`docs/architecture.md`) | The user asked for vertical slices. One feature spans Rust, Node and React, so slicing across packages is impossible. Inside, the designer is `app` → `features` → `shared` (a test enforces it), and engine write ops are one module each. |

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
- **Push when done and green, without asking** (the user's standing instruction, 2026-10-08):
  once a task is complete and the whole gate passes (§2), push `main`, then say so. Never push
  red or unfinished work. Check `git log origin/main..main --format='%ae %ce'` first.
- **Commit identity:** `kylesmile1103@gmail.com`, in the repo-local git config. The global
  config holds a work email that must never reach the remote. `.git/hooks/pre-commit` and
  `pre-push` enforce this (case-insensitive). Never use `--no-verify`.
- **Selecting a Chrome browser:** if clicks don't register, run `/chrome` to pick the right browser (a backgrounded or other browser drops presses). After HMR, `import()`-ing a module in the page gives a fresh copy, so trust screenshots.
- **Probing agents write to live servers.** Stop your dev servers, or keep them on ports no agent knows, while review or verify agents run, and check `git status` afterwards.
- **The plugin's vitest copies `examples/playground` and `examples/refine-admin` as they are on disk.** Leftover edits from a
  manual or agent session there fail ten unrelated-looking MCP tests. `git checkout -- examples/`
  (and delete new files) first.
- **Positions in a payload go stale; keys don't.** A drift fix that carried an index ("rebuild
  = remove + add at 2") was applied after another fix had shifted the columns, whenever a click
  beat the list's refresh: a flaky e2e found it. Fixes now name keys, and `rebuild` is resolved
  when planned. Anything the designer holds while the source changes must work the same way.
- **The examples run the *built* plugin.** After changing `packages/vite-plugin-ast-locator`,
  run `pnpm build:plugin` before Playwright, or the dev servers serve the old routes (an e2e run
  saw `unknown endpoint /refine/drift`).
- **Re-run the *whole* suite after touching docs.** `errors.rs` pins one `docs/api.md` example
  per `Op` variant.
- **Never run `cargo fmt`.** The repo isn't rustfmt-formatted: it uses long lines, and the
  default config rewrote every engine file (7000 lines of diff). If it happens, restore the
  crate from git and re-apply the edits.
- **A page that isn't on disk has no Tailwind classes.** Tailwind v4 finds candidates in files
  on disk, so the inferencer's preview modules bring a stylesheet (`@reference` the app's CSS,
  `@source inline(…)` the page's classes). A screenshot found it: the e2e checked roles, not
  layout. Look at new UI, don't only query it.
- **Preview modules resolve twice.** The browser asks for `/@trivia/preview/<id>.tsx`, but
  Vite writes imports between previews as `/src/.trivia-preview/<id>.css` (the resolved path
  from the root). It also resolves a module's own absolute id again for HMR. The plugin's
  `resolveId` claims all three forms.
- **Sync refuses while the generated code has uncommitted changes**, which protects hand edits.
  After changing the example's spec, commit the regenerated `src/api/generated` before running
  Playwright, or the drift e2e times out waiting for a sync that was refused. The plugin's
  tests copy the example outside git, so they never see this.

## 7. Backlog / next steps (in priority order)

The order is the product's (`docs/product.md`, Slices):
1. **Have the user try it on one of their real internal tools.** Slices 1–6 are done; what
   breaks on a real codebase decides what comes next. Likely candidates:
   - pages whose shape the adapter doesn't read (`register()` forms, columns from a helper);
   - other UI kits (an Ant Design or MUI adapter beside `src/refine/`);
   - Next.js;
   - selection that follows JSX renumbered by a value op.
2. Review the ⚑ decisions in `docs/product.md`.
3. A narrower drift fix for changed enum options: update the options in place instead of
   rebuilding the column or field. A real agent showed that a rebuild drops customisations
   (`docs/mcp.md`, the Refine session). The rule half is now one `setCallArgument` on `z.enum`.
   The `<SelectItem>`s and a column's filter options still need their own in-place edit.

Not on the path (only if the user asks): the shell's WebKit hand test, a Linux or Windows build
and a `tauri build` bundle; the Data tab's TanStack-path forms (edit forms, nested objects).

## 8. Repo map

The full layout and its rules are in `docs/architecture.md`. In short:

- `crates/trivia_oxc_engine/src/`:
  - `locator.rs` (locators, `annotate`, `JsxTable`), `text.rs` (edits, line helpers),
    `import_manager.rs`, `workspace.rs` (the only I/O);
  - `inspect.rs` and `prop_analyzer.rs` (reads);
  - `ops/` (writes): `mod.rs` holds `Op` and the shared machinery, plus `insert.rs`,
    `update_prop.rs`, `set_text.rs`, `remove.rs`, `move_node.rs` and `bind_query.rs`.
- `crates/trivia_napi/`: the napi binding (JSON envelope API), package `@trivia/engine`.
- `packages/vite-plugin-ast-locator/src/`: `transform.ts` (locators), `api/` (HTTP routes,
  `service.ts` with the queue, undo history and selection, `guard.ts`), `mcp/` (the MCP
  endpoint and tools), `options.ts` (uiDir/importBase from `components.json`).
- `packages/designer/`:
  - `server/` (the API guard);
  - `src/app/` (shell);
  - `src/features/`:
    - `canvas/` (overlay, hit testing, drop zones, previews);
    - `inspector/` (props, class manager, `style/` panel, `tailwind/` CSS→Tailwind);
    - `palette/` (catalog and templates);
    - `toolbar/`;
  - `src/shared/`:
    - `engine/` (API client, TS types mirroring Rust serde, session);
    - `state/` (zustand store, action bus);
    - `commands/`, `ui/` (shadcn), `canvas.ts`, `template.ts`.
- `packages/contract-sync/src/`: `adapters/` → `spec/` → `codegen/` → `manifest/`, orchestrated
  by `sync.ts`.
- `examples/playground/`: a stock create-vite + shadcn (radix, nova) user app.
- `e2e/*.spec.ts`: Playwright (`playwright.config.ts`, ports come from env).
- `references/` (gitignored, read-only): tango, oxc, oxbox, openapi-ts, onlook, refine.
