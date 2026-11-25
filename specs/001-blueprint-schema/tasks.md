# Tasks: Blueprint schema and store

**Input**: [spec.md](spec.md), [plan.md](plan.md), LLD-01
**Format**: `- [ ] T### [P?] [US#] description`. `[P]` can run in parallel with its neighbours.
Tests come before the code they cover and must fail first.

## Phase 1: Setup

- [x] T001 Generate the package with `nx g @trivia/tools:package blueprint`. Add zod, and ajv as a dev dependency, at the repository's versions
- [x] T002 Add the commit areas `blueprint:`, `compiler:` and `dotnet:` to `release.conventionalCommits.types` in `nx.json`
- [x] T003 [P] Write the hand-made fixture `packages/blueprint/fixtures/valid/backoffice/` (app, a `list` page, a `custom` page using every map)

## Phase 2: Foundational

- [x] T004 [P] Zod schemas and types in `src/types/app.ts` and `src/types/page.ts`, with id and name patterns
- [x] T005 [P] `src/types/diagnostics.ts` and `src/types/ops.ts` (the op union, without model ops)
- [x] T006 Round-trip tests in `src/serialize.test.ts` (canonical fixture, shuffled keys, defaults omitted, final newline)
- [x] T007 `src/serialize.ts`: canonical JSON and `rev()`
- [x] T008 [P] `src/ids.ts` with an injectable source, and tests
- [x] T009 [P] `src/order.ts` fractional keys, with the 1 000-insert test

## Phase 3: User Story 1 - Describe a page (P1)

- [x] T010 [US1] `src/store.ts` `read()`: load every document, tolerate a broken file, compute revs. Tests on the fixture and on a directory with one malformed file
- [x] T011 [US1] Schema validation (`src/validate/schema.ts`) with pointer-accurate diagnostics. One fixture per violation kind in `fixtures/invalid/schema_violation/`

## Phase 4: User Story 2 - Guarded operations (P1)

- [x] T012 [US2] Op fixtures `fixtures/ops/<op>/{before,ops,after}` for the app and page groups
- [x] T013 [US2] `src/apply/page.ts`: `createPage`, `deletePage`, `setPageMeta`
- [x] T014 [US2] `src/apply/nodes.ts`: `addNode`, `removeNode` (subtree), `moveNode`, `renameNode` (reference rewrite through the injected function)
- [x] T015 [P] [US2] `src/apply/values.ts`: `setProp`, `setBinding`, `setStyle`, `setControl`
- [x] T016 [P] [US2] `src/apply/logic.ts`: `setState`, `removeState`, `setQuery`, `removeQuery`, `setActions`
- [x] T017 [P] [US2] `src/apply/app.ts`: `setApp`, `setNav`
- [x] T018 [US2] `src/apply/index.ts`: the batch reducer with `baseRev` and `expectedType` guards and all-or-nothing commit. Tests for each refusal code
- [x] T019 [US2] `store.apply()` returning `FileWrite[]`, with the diff-locality test (SC-002)
- [x] T020 [US2] Property test: random valid op sequences keep layers 1 and 2 valid

## Phase 5: User Story 3 - Diagnostics (P1)

- [x] T021 [US3] Fixtures per code under `fixtures/invalid/<code>/` for the reference layer
- [x] T022 [US3] `src/validate/references.ts`: parents, root, cycles, slots present, prop in one map, action keys, nav, routes
- [x] T023 [US3] `src/validate/context.ts`: the interface for manifest, contract and expression checks, and `validate()` composing all layers with layer skipping
- [x] T024 [US3] Hints: attach fixing ops where one exists (duplicate prop, dangling nav entry)

## Phase 6: User Story 4 - Migrations (P2)

- [x] T025 [US4] `src/migrate/index.ts` with a test-only `v0-to-v1` migration and the `unsupported_version` refusal

## Phase 7: User Story 5 - Projection (P3)

- [x] T026 [US5] `src/project.ts` with snapshot tests on the fixture pages

## Phase 8: Polish

- [x] T027 [P] Emit `schemas/app.v1.json` and `page.v1.json` from zod at build. Test: ajv strict validates every valid fixture and rejects every schema fixture
- [x] T028 [P] Performance test for SC-004 with a generated 200-page blueprint
- [x] T029 Document the format in `docs/blueprint/lld/LLD-01-blueprint-schema.md` where the implementation refined it, and resolve its open points
- [x] T030 Run `pnpm check`

## Dependencies

T004 to T009 block everything after them. US2 needs US1's store read. US3's context interface
(T023) is what specs 002, 003 and 008 plug into. US4 and US5 are independent of each other.
