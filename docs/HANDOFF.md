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
## 1. Status (2026-10-08, end of session 2)

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

**Gate on `main` (all green):**
- `cargo test --workspace` 243/243 (17 suites); clippy `-D warnings` clean.
- Vitest: plugin 94, designer 411 (including 6 architecture rules), contract-sync 76.
- napi crash suite 30/30, with RSS bounds.
- `pnpm typecheck` clean; designer oxlint has 0 errors.
- Playwright 37/37, twice in a row.
- Not re-done in session 2: the Claude in Chrome manual pass. Session 1's is described below,
  and Playwright covers the same flows. No real Claude Code session has used the MCP endpoint
  yet: the SDK client in the tests stands in for it.

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
- **Re-run the *whole* suite after touching docs.** `errors.rs` pins one `docs/api.md` example
  per `Op` variant.

## 7. Backlog / next steps (in priority order)

1. **Try point and ask in a real Claude Code session**
   (`claude mcp add --transport http trivia http://localhost:5173/@trivia/mcp`), and fix what a
   real agent trips on (tool descriptions, error hints).
2. MCP follow-ups: a screenshot tool ("agent builds, you watch") and `trivia_sync_openapi`.
3. A Tauri shell. The engine is already a plain Rust library, and the shell can load the
   designer's localhost URL and stay same-origin, so no bridge is needed.

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
