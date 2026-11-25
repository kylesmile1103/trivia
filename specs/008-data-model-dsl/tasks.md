# Tasks: Data model DSL

**Input**: [spec.md](spec.md), [plan.md](plan.md), LLD-08
**Depends on**: spec 001

## Phase 1: Setup

- [x] T001 Write `fixtures/model/valid/bank/model.blueprint.json` by hand: Customer, Account, Transaction, every type, constraint and relation kind, one custom operation
- [x] T002 [P] Reserved word data files with a header naming source and date: `reserved/csharp.json`, `postgres.json`, `generator.json`

## Phase 2: Foundational

- [x] T003 `src/model/types.ts`: the zod schema, name patterns, per-type constraint rules. Round-trip test with array order kept
- [x] T004 `src/model/mapping.ts`, and a script test that regenerates `fixtures/model/model-mapping.json` and fails on a difference

## Phase 3: User Story 1 - Entities and fields (P1)

- [x] T005 [US1] Fixtures and checks for `duplicate_name`, `reserved_name`, `invalid_default`, `invalid_constraint` in `src/model/validate.ts`

## Phase 4: User Story 2 - Relations (P1)

- [x] T006 [US2] Fixtures and checks for `dangling_reference`, `unmatched_relation` (with its fixing op), implied foreign keys, key type agreement, self-relations

## Phase 5: User Story 3 - Ops (P1)

- [ ] T007 [US3] Op fixtures, then `src/model/apply.ts`: `setModel`, `setEnum`, `removeEnum`, `setEntity`, `removeEntity`, `renameEntity`, `setField`, `removeField`, `renameField`, `moveField`, `setRelation`, `removeRelation`, `setIndexes`, `setEntityApi`
- [ ] T008 [US3] Add the model ops to the op union and the batch reducer of spec 001. Refusal tests
- [ ] T009 [US3] The plugin's summary and MCP input schema pick the new ops up (snapshot updates in spec 004's tests)

## Phase 6: User Story 4 - API options (P2)

- [ ] T010 [US4] `invalid_api` checks: list membership by type, custom operation path collisions, plural collisions

## Phase 7: User Story 5 - Breaking changes (P3)

- [ ] T011 [US5] Record the last generated model revision and a field summary in the lock (written by spec 010's orchestration). `breaking_change` warnings against it

## Phase 8: Polish

- [ ] T012 [P] Emit `schemas/model.v1.json`. ajv strict test over the fixtures
- [ ] T013 Edge cases: enum values that are not identifiers, self-relations, mixed key types
- [ ] T014 Run `pnpm check`

## Dependencies

T003 blocks all. US3 needs US1 and US2's validation to refuse dangling results. T011 needs
spec 010.
