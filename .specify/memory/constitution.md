# Trivia Constitution

The rules every specification, plan and task in `specs/` must satisfy. They restate the
load-bearing rules of `CLAUDE.md` and add the ones the blueprint track needs. Where this file
and `CLAUDE.md` disagree, `CLAUDE.md` wins and this file is corrected.

## Core principles

### I. Clean room (non-negotiable)

No source file of Openblocks or Lowcoder is read, translated, cloned into `references/` or
placed in an agent's context. Concepts, public documentation and observed behaviour are the
only inputs. All code in this repository is MIT. A task that cannot be done without their
source is not done. (ADR-0001)

### II. The code is the truth

A file that exists is changed only by span splices through the engine. Bytes outside the edited
ranges stay identical. Nothing regenerates over a hand edit: an ejected page is replaced only
while its hash matches the lock, and generated C# lives in `*.g.cs` files apart from the user's
code. (`CLAUDE.md` rule 1, ADR-0003, ADR-0011)

### III. One semantics

There is no interpreter of blueprints. A preview is the compiled module, and eject writes the
same bytes. A feature that would need a second evaluator is redesigned. (ADR-0004)

### IV. Plans, not direct writes

Generators return Ops or a file plan. One path applies them: the service's edit queue for
source and blueprint files, `trivia-dotnet write` for the backend. Every change to source or
blueprint is one labelled entry of the shared undo history. A failed operation writes nothing.

### V. Guards fail loudly

Every write names what it expects to find: an element name, a revision, a content hash. When
the expectation does not hold, the operation is refused with a stable error code and nothing is
guessed. Locators are positions, not identities.

### VI. Deterministic and local

The same inputs give the same bytes: blueprint serialization, emitted TSX, emitted C#. No
timestamps, random values or machine paths in output. Validation and compilation work offline.
No telemetry.

### VII. The user owns the output

Emitted apps import nothing from `@trivia/*` at run time. Components come from the shadcn
registries into the user's project and are never vendored by the compiler. Emitted code must
re-parse without diagnostics and pass `tsc`. Emitted solutions must build with warnings as
errors.

### VIII. Test first, at the contract

A behaviour change starts with a test that fails. Emitters are pinned by golden files and
snapshots. Each requirement of `docs/blueprint/SRS.md` has a test that names it. A new
endpoint, MCP tool or engine op ships with its `docs/` entry and an example the tests pin.

### IX. Verify fast-moving APIs

OXC, Next.js, Aspire, .NET, Refine and shadcn change between releases. Before writing code
against one, read its current documentation or its source in `references/`, and pin the exact
version. Snippets in the design documents show intent, not final API names.

### X. Stay small

The hosted runtime, an interpreter, connectors, server-side evaluation of user JavaScript,
MongoDB and round trip from code to blueprint are out until the Phase 4 gate opens. A plan that
needs one of them is stopped and raised with the owner. (ADR-0014)

## Engineering constraints

- **Layout.** Packages by deployable at the top, feature slices inside
  (`docs/architecture.md`). In the designer, `app` imports `features`, which import `shared`,
  and a feature never imports another feature. Engine write ops are one module each.
- **Offsets.** Rust spans are UTF-8 bytes, JavaScript's are UTF-16. Every value that crosses
  the boundary states its unit.
- **One locator algorithm**, in Rust, for every host.
- **Imports are derived**, and only for the names an operation touched.
- **Security.** The API answers this machine only. Paths are contained in the project root.
  Child processes are started with argument arrays. Blueprint expressions are parsed, never
  evaluated, by the tool.
- **Toolchain.** Node 22.16+, pnpm, Nx, Rust 1.97+, OXC pinned to one exact version across
  crates, .NET 10 for `dotnet/`.

## Workflow

- A feature is `specs/NNN-name/` with `spec.md` (what and why), `plan.md` (how, pointing at its
  LLD in `docs/blueprint/lld/`) and `tasks.md`. The LLD is the design authority. When the two
  differ, fix the LLD first, then the plan.
- Gates before a task list is called done: `pnpm check`, `pnpm e2e` for anything the designer
  or plugin shows, `dotnet test` for anything under `dotnet/`.
- The gate runs in a scratch git worktree when `examples/` has uncommitted edits or dev
  servers are running (`docs/HANDOFF.md`).
- Commit messages start with their area: `engine:`, `plugin:`, `designer:`, `MCP:`, `docs:`,
  `repo:`, and for this track `blueprint:`, `compiler:`, `dotnet:`. The new areas are added to
  `release.conventionalCommits.types` in `nx.json` with the first commit that uses them.
- Decisions made by an agent while the owner is away are marked ⚑ where they are written down
  and listed for review.

## Governance

This constitution outranks plans and tasks. A plan that must break a principle says so in its
Constitution Check, with the reason and the simpler alternative that was rejected, and the
owner approves it before work starts. Changing a principle needs a new ADR and a version bump
here.

**Version**: 1.0.0 | **Ratified**: 2026-11-25 | **Last amended**: 2026-11-25
