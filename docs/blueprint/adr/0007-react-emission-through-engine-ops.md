# ADR-0007: React emission: printed new files, engine Ops for existing ones

- Status: Accepted
- Date: 2026-11-25
- Requirements: FR-RC-01 to FR-RC-07, NFR-01

## Context

The research offered two ways to emit React: compile every node into a sequence of Trivia Ops,
or print whole files. Ops are guarded and byte-preserving, which matters for files that already
exist. For a file that does not exist yet there is nothing to preserve, and building it one
insert at a time is slow and hard to read.

## Decision

- A new file is printed as text by the compiler and written with `createFile`.
- A change to an existing file (the router, `<Refine resources>`, navigation) is an Op.
- A re-eject of an untouched file is `replaceFile` (ADR-0003).
- Contract pages are not printed by new code: the compiler calls the Refine adapter's
  generator, so there is one implementation of those pages.
- The compiler returns a plan. The designer or the MCP tool applies it through `/batch` as one
  undo entry.

The printer is deterministic. It does not call a formatter. ⚑ It follows the project's
semicolon and quote style, read from the app's entry file.

## Consequences

- Every write still goes through the engine: re-parsed, refused on diagnostics, atomic, undoable.
- Imports follow rule 9 for existing files and are derived from references for new ones.
- The printer is a second place where TSX layout is decided. Golden files pin it.

## Alternatives

- **All Ops.** Uniform, but hundreds of ops for one page and no gain in safety.
- **Print and run Prettier or Biome.** Output would depend on a tool and a config we do not
  control, which breaks determinism in tests.
