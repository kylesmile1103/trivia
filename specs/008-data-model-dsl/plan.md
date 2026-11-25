# Implementation Plan: Data model DSL

**Branch**: `008-data-model-dsl` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: [LLD-08](../../docs/blueprint/lld/LLD-08-data-model-dsl.md) · ADR-0005, ADR-0010

## Summary

The model document's schema, ops and validation, added to `@trivia/blueprint`, plus the type
mapping table and the JSON Schema that `trivia-dotnet` reads.

## Technical Context

- **Language**: TypeScript, `packages/blueprint/src/model/`.
- **Dependencies**: none new.
- **Testing**: Vitest, fixtures per diagnostic, a generated mapping fixture.
- **Constraints**: ordered arrays for enums, entities, fields and relations. Reserved word
  lists as data files with their sources named.

## Constitution Check

| Principle | Status |
| --- | --- |
| V Guards | Model ops carry `baseRev`. Removals that would dangle are refused |
| VI Deterministic | Canonical serialization keeps array order |
| VIII Test first | The mapping fixture is a contract test between two languages |

No violations.

## Project Structure

```
packages/blueprint/src/model/
  types.ts           zod schema for model.v1
  mapping.ts         the type table
  apply.ts           model ops
  validate.ts        model diagnostics
  reserved/csharp.json, reserved/postgres.json, reserved/generator.json
packages/blueprint/fixtures/model/
  valid/bank/model.blueprint.json        Customer, Account, Transaction
  invalid/<code>/
  model-mapping.json                     generated, committed
packages/blueprint/src/schemas/model.v1.json   emitted at build
```

## Approach

1. Schema and the fixture.
2. The mapping table and its generated fixture.
3. Validation, one code at a time.
4. Ops, with renames.
5. `breaking_change` against the lock's last generated revision.

## Risks

- **Two mapping tables** (TypeScript and C#). The shared fixture is the guard.
- **Reserved word lists go stale.** Their source and date are in each file's header.
