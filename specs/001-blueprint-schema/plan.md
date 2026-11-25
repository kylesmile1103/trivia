# Implementation Plan: Blueprint schema and store

**Branch**: `001-blueprint-schema` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: [LLD-01](../../docs/blueprint/lld/LLD-01-blueprint-schema.md) · ADR-0005, ADR-0013

## Summary

A new TypeScript package, `@trivia/blueprint`, with the document types (zod), canonical
serialization, the BlueprintOp reducer, layered validation, migrations, a store that computes
file writes, and a read-only projection. Pure functions throughout. The only I/O is the
store's read.

## Technical Context

- **Language**: TypeScript 6, ESM, built like `packages/contract-sync` (tsc, `dist/`).
- **Dependencies**: zod (the repository's version), a ULID generator and fractional indexing
  written in the package (about 60 lines each, no dependency). ajv in tests only.
- **Storage**: JSON files under `<root>/blueprint/`.
- **Testing**: Vitest beside the code; fixtures in `fixtures/`; one property test.
- **Performance**: SC-004.
- **Constraints**: no dependency on the engine, the plugin or the network. Deterministic
  output (id generation is injected, so tests are stable).

## Constitution Check

| Principle | Status |
| --- | --- |
| I Clean room | Format designed from ADR-0005. No external source consulted |
| II Code is the truth | Not applicable: this package never touches source files |
| IV Plans, not writes | The store returns `FileWrite[]`. It does not write |
| V Guards | `baseRev` and `expectedType` on every op |
| VI Deterministic | Canonical serializer, injected id and clock-free |
| VIII Test first | Fixtures and op tests precede the reducer |

No violations.

## Project Structure

```
packages/blueprint/
  package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, project.json (via the generator)
  src/
    index.ts
    types/            app.ts, page.ts, ops.ts, diagnostics.ts   (zod schemas and inferred types)
    serialize.ts      canonical JSON, rev()
    ids.ts            ULID with an injectable source
    order.ts          fractional index keys
    apply/            one file per op group, plus index.ts (the batch reducer)
    validate/         schema.ts, references.ts, context.ts (the injected checks), index.ts
    migrate/          index.ts, app/, page/
    store.ts          read() and apply() over a directory
    project.ts        the JSX-like projection
    schemas/          emit JSON Schema from zod (build step), app.v1.json, page.v1.json
  fixtures/           valid/, invalid/<code>/, ops/<op>/{before,ops,after}
```

Created with `nx g @trivia/tools:package blueprint`.

## Approach

1. Types and schemas, with the fixture blueprint written by hand first.
2. The serializer and `rev`, proven by round trips.
3. Ids and order keys.
4. The reducer, one op group at a time, each from its `before`/`ops`/`after` fixture.
5. Validation layers 1 and 2, then the context interface for layers 3 to 5.
6. The store and migrations.
7. The projection and the JSON Schema emit.

## Risks

- **Schema churn after other features start.** Kept behind `blueprintVersion`, and the
  migration mechanism ships with version 1 for that reason.
- **Canonical form versus zod defaults.** Defaults are omitted on write, so adding a default
  later does not rewrite files. Covered by a test.
