# CI/CD

GitHub Actions on GitHub-hosted runners, which are free and unmetered for a public repository.
This file is the design: what runs where, why, and what the repository settings must say.
Decisions made without the owner are marked ⚑.

## Goals

1. A pull request is not mergeable unless the same gate a developer runs locally passes:
   `pnpm check` (build, typecheck, lint, test of every Nx project) and `pnpm e2e`.
2. Feedback in minutes: the jobs a pull request waits on run in parallel, reuse caches, and
   skip nothing that matters.
3. Safe for a public repository: forks get a read-only token, no secret reaches code from a
   pull request, every third-party action is pinned to a commit.
4. Releases from the browser: cutting `v0.3.0` needs no Mac and no local token.
5. Drift is caught without slowing pull requests: a nightly run repeats the gate uncached and
   on every operating system.

## Workflows

| File | Runs on | Jobs |
| --- | --- | --- |
| `ci.yml` | pull requests, pushes to `main` and `ci/**`, manual, called by `release.yml` | `gate`, `integration`, `e2e`, `desktop`, `workflows`, `ci-ok` |
| `nightly.yml` | daily 03:17 UTC, manual, pushes that change it | `full` (3 OS, Windows on request), `integration`, `e2e` |
| `release.yml` | manual, `main` only | `gate` (calls `ci.yml`), `release` |
| `codeql.yml` | pull requests and pushes to `main`, weekly | `analyze` (JavaScript/TypeScript, Rust, Actions) |
| `dependency-review.yml` | pull requests | `review` |

`.github/actions/setup` is the one setup every job shares: pnpm (the version
`packageManager` names), Node (`.node-version`), Rust (`rust-toolchain.toml`) with its build
cache, the Nx cache, and `pnpm install --frozen-lockfile`.

### `ci.yml`: the pull request gate

| Job | Runner | What | Why there |
| --- | --- | --- | --- |
| `gate` | `ubuntu-24.04` | `nx run-many -t build typecheck lint test --exclude shell` (+ .NET when `dotnet/` exists) | The local gate. Linux is the fastest and cheapest runner. |
| `integration` | `ubuntu-24.04` | `nx run dotnet:integration`: the generated API against PostgreSQL, the Aspire AppHost, Compose publishing; then the BankAdmin MVP slice, required (`nx run tools:mvp`, spec 011), and the generated Next.js app's production build (`TRIVIA_NEXT_BUILD=1 nx test blueprint-compiler`, spec 012). Docker, .NET 10, `dotnet-ef`, the Aspire CLI 13.6.5 from its install script | The container tests, kept out of `pnpm check` so the local gate needs no Docker (LLD-10). Linux runners have Docker. |
| `e2e` | `ubuntu-24.04` | `pnpm e2e` (Playwright, Chromium; .NET for `trivia-dotnet` and the Aspire CLI for the BankAdmin MVP project), report uploaded on failure; then `nx run tools:adopt`, the getting-started recipe on a copy of the Refine example outside the workspace (it installs from the registry, so it is not in `pnpm check`) | Runs beside `gate`, not after it: both build what they need, and the wall time is the longer of the two. |
| `desktop` | `macos-15` (Apple silicon) | `nx run-many -t lint test -p shell` | The Tauri shell ships for macOS only, and on Linux it would need WebKitGTK headers. ⚑ |
| `workflows` | `ubuntu-24.04` | actionlint over `.github/workflows` | A broken workflow fails in review, not after merge. |
| `ci-ok` | `ubuntu-24.04` | succeeds only if every job above succeeded | The one check branch protection requires, so adding a job never needs a settings change. |

Triggers, and the trap they avoid. ⚑ CI runs on `pull_request` (every pull request, forks
included), on pushes to `main`, and on pushes to `ci/**` branches (so a change to CI is tested
on its own branch before it has a pull request). It does not run on every branch push. The
common alternative, every push plus fork-only pull requests, gives an internal pull request two
runs on the same commit, one of them skipped, and GitHub treats a skipped required check as
passed. A branch without a pull request gets CI when the pull request is opened (`/ship` does
that).

Concurrency: one run per pull request or branch; a new push cancels the older run, except on
`main`, where every commit is checked.

### Caches

| Cache | Key | Saved by |
| --- | --- | --- |
| pnpm store | `pnpm-lock.yaml` | `actions/setup-node` |
| Rust `target/` and registry | `Cargo.lock`, toolchain, job | `Swatinem/rust-cache` |
| Nx task cache (`.nx/cache`) | OS, job, commit; restored by prefix | an explicit save step |
| Playwright browsers | Playwright's version | an explicit save step |

⚑ Caches are written only by runs on `main`. Pull requests restore from `main` (GitHub lets a
branch read its base branch's caches) and never write, so the repository's 10 GB cache budget
holds one good set instead of one per branch, and a pull request cannot poison what `main`
reads.

The Nx cache makes a pull request that touches one package re-run only that package's tasks.
It is only as correct as each target's `inputs` (`CLAUDE.md`: a test that reads a file outside
its project must list it). The nightly run uses `--skip-nx-cache`, so a missing input shows up
there within a day instead of hiding behind a stale pass.

### `nightly.yml`: everything, uncached, on Linux and macOS

`pnpm check --skip-nx-cache` on `ubuntu-24.04`, `ubuntu-24.04-arm` and `macos-15`, the shell and
the .NET tests included (Linux installs the WebKitGTK headers first), and the container tests and
`pnpm e2e` on Linux. `fail-fast` is off, so one broken platform does not hide the others. A
nightly failure does not block anyone; it is a signal to look.

⚑ Windows is not supported yet (2026-11-26). Nobody uses Trivia on Windows, and the leg never
passed. It runs only when the nightly is dispatched with `windows: true` (it checks out with
`core.autocrlf false`, so the byte-exact fixtures stay byte-exact). Known failures:

1. `engine:build`: `napi build` (@napi-rs/cli 3.10.8 and 3.10.12) times out after 120 s on its
   own "filesystem reconciliation lock", repeating `…candidate.<uuid>.swp changed before
   retirement`. Every other project depends on this build. Report for napi-rs, not filed yet:
   [upstream/napi-rs-windows-lock.md](upstream/napi-rs-windows-lock.md).
2. `designer:test`, `codegen.node.test.ts`: `node <tmp>\node_modules\typescript\bin\tsc` is not
   found through the junction from the temp directory on `C:` to the checkout on `D:`.

Revisit when a Windows user appears, the desktop shell targets Windows, or a napi-rs CLI release
fixes (1): after the next `@napi-rs/cli` bump, dispatch the nightly once with `windows: true`, and
put Windows back on the schedule only when the whole leg is green.

### `release.yml`: continuous delivery

Manual (`workflow_dispatch`) from `main`, with two inputs: `version` (`x.y.z`, `major`,
`minor` or `patch`) and `dry-run` (⚑ on by default, so a stray click changes nothing).

1. `gate` calls `ci.yml` on the same commit: nothing is released that did not just pass,
   the BankAdmin MVP slice included (its `integration` job).
2. `release` runs on `macos-15` (the desktop app is built for Apple silicon) with
   `contents: write`, and runs the same `pnpm release` a developer runs locally
   (`tools/release/release.mjs`): `nx release` bumps every version, writes `CHANGELOG.md`,
   commits `release: vX.Y.Z`, tags, pushes, and creates the GitHub release; then it builds the
   `.dmg` and attaches it. The token is the workflow's own `GITHUB_TOKEN`, scoped to this job
   and this repository. The release commit is authored by `github-actions[bot]`. The runner has
   no Docker, so `pnpm release` trusts the gate job's MVP slice (`TRIVIA_MVP_GATE_PASSED`,
   honoured only on GitHub Actions); a local release runs the slice itself.

Nothing is published to npm, as before. The job uses the `release` environment, which can be
given required reviewers in the settings without changing the workflow.

### Security

- Every third-party action is pinned to a full commit SHA, with its version in a comment.
  Dependabot (`.github/dependabot.yml`, the `github-actions` ecosystem only) proposes updates
  weekly. ⚑ npm and Cargo updates stay manual: the repository pins OXC, hey-api and the MCP
  SDK to exact versions on purpose (constitution IX), and a bot bumping one OXC crate would
  break the rule that all of them move together.
- `permissions: contents: read` at the top of every workflow; a job asks for more only when it
  needs it (`release`: `contents: write`; `codeql`: `security-events: write`).
- No `pull_request_target`. Fork pull requests run with a read-only token and no secrets.
- `actions/checkout` with `persist-credentials: false` everywhere except the release job, which
  pushes. No `${{ … }}` expression from an event payload is expanded inside a `run:` script;
  inputs go through `env:` and are validated.
- CodeQL (JavaScript/TypeScript, Rust and the workflows themselves) and dependency review (fails on
  high-severity advisories) on every pull request.

### Toolchain pins

⚑ `rust-toolchain.toml` pins Rust 1.99.0 with clippy, and `.node-version` pins Node 22.16.0,
the versions `CLAUDE.md` names. Before, a shell could pick 1.97 or 1.99 (HANDOFF), so local
clippy and CI clippy could disagree about the same code.

## Repository settings (owner, once)

1. **Branch protection on `main`** (rulesets, set 2026-11-27):
   - "main: never rewritten or deleted" blocks force pushes and deleting `main`, for everyone.
   - "main: changes land through a PR with ci-ok green" requires a pull request (no approvals:
     the owner works alone with agents) and the `ci-ok` check. Branches need not be up to date.
     The repository admin role may bypass it, so `pnpm release` run locally can push its
     release commit. Agents use the owner's account, so they get that bypass too; they still
     open a pull request for every change and merge it only when `ci-ok` is green.
   - `release.yml` pushes its commit as `github-actions[bot]` (the job's `GITHUB_TOKEN`). Add
     the GitHub Actions app to the second ruleset's bypass list, or that push is refused; only
     the `release` job has `contents: write`. (Not added yet: the owner's call.)
2. **Actions → General**: "Require approval for first-time contributors" (the default), and
   workflow permissions "Read repository contents".
3. **Code security**: Dependabot alerts, secret scanning and push protection (free for public
   repositories), private vulnerability reporting.
4. **Environments**: optionally add required reviewers to `release`.

## Running it

- Every pull request: automatic. Re-run a failed job from the Checks tab.
- The nightly run on demand: Actions → Nightly → Run workflow (tick `windows` to add the
  unsupported Windows leg).
- A release: Actions → Release → Run workflow on `main`, `version: 0.3.0`, first with
  `dry-run` on, then off.
