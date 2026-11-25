# Development

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

Conventions, design rules and gotchas are in [`CLAUDE.md`](../CLAUDE.md); the working notes for picking up
the project are in [`docs/HANDOFF.md`](HANDOFF.md).

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
| Containers | `nx run dotnet:integration` | The generated API against PostgreSQL, the Aspire AppHost and Compose publishing. Needs Docker and the Aspire CLI; not part of `pnpm check`. |
| Tooling | `nx test tools` | The generator, the release version actions and changelog rules. |

Playwright ports come from the environment so you can run beside a live session:

```sh
TRIVIA_APP_PORT=5311 TRIVIA_PORT=4411 \
TRIVIA_REFINE_APP_PORT=5312 TRIVIA_REFINE_PORT=4412 \
TRIVIA_NEXT_APP_PORT=5313 TRIVIA_NEXT_PORT=4413 TRIVIA_NEXT_API_PORT=4513 \
  pnpm e2e
```

`pnpm e2e` builds the Vite and Next.js packages first. CI runs the same gate on every pull
request: [CI/CD](ci.md).

## Contributing

1. Read [`CLAUDE.md`](../CLAUDE.md) and [`docs/architecture.md`](architecture.md) first. The rules are
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
