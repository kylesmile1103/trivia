# Tasks: Expression compiler

**Input**: [spec.md](spec.md), [plan.md](plan.md), LLD-03
**Depends on**: nothing at build time. Integration tasks need specs 001 and 002.

## Phase 1: Setup

- [x] T001 Create `crates/trivia_expr` (Cargo.toml on workspace dependencies, `project.json` with build, test and lint targets), add it to the root workspace members
- [x] T002 Read the pinned OXC's parser, visitor and span APIs in `references/oxc` and note the names used, at the top of `src/parse.rs`

## Phase 2: Foundational

- [x] T003 `src/parse.rs`: parse a single expression, map spans back, limits (4 096 bytes, depth 64) as `expr_too_large`. Tests in `tests/limits.rs`
- [x] T004 [P] `src/utf16.rs` with astral-character tests
- [x] T005 [P] Request and response serde types in `src/lib.rs`

## Phase 3: User Story 1 - Diagnostics (P1)

- [x] T006 [US1] `tests/tables.rs`: the accepted and refused tables of LLD-03 section 1, one line per form with code and span
- [x] T007 [US1] `src/subset.rs`: the syntax walk
- [x] T008 [P] [US1] `src/allow.rs` and the purity check (`expr_impure_call`)
- [x] T009 [US1] `src/scope.rs`: roots, locals, arrow parameters, shadow warning, `expr_unknown_root`, `expr_unknown_member`

## Phase 4: User Story 2 - Dependencies and tiers (P1)

- [x] T010 [US2] Tests for dependency lists and tiers, including query-derived tiers
- [ ] T011 [US2] `src/deps.rs`

## Phase 5: User Story 3 - Cycles (P2)

- [ ] T012 [US3] `tests/cycles.rs`, then `src/graph.rs`

## Phase 6: User Story 4 - Emission (P1)

- [ ] T013 [US4] `tests/emit.rs`: identity round trips over every accepted expression, rename cases, CRLF
- [ ] T014 [US4] `src/emit.rs`: longest-prefix rename by splice, re-parse check
- [ ] T015 [US4] `rename_references` for the `renameNode` op, with tests

## Phase 7: Binding and integration

- [ ] T016 `crates/trivia_napi/src/expr.rs`: `analyzeExpressions`, `emitExpressions`, `renameReferences`, with panics caught as `internal`. Update `index.d.ts`
- [ ] T017 Add the three functions to the napi crash suite with the RSS bound
- [ ] T018 In `@trivia/blueprint`: build the scope for a page (state, queries, `ui` from spec 002 T011, locals) and call the analyzer through the validation context. Fixtures per `expr_*` code
- [ ] T019 Wire `renameNode` (spec 001 T014) to `renameReferences`

## Phase 8: Polish

- [ ] T020 [P] `fuzz/fuzz_targets/analyze.rs`, run for SC-003
- [ ] T021 [P] `benches/analyze.rs` and a CI check for NFR-04
- [ ] T022 `cargo clippy -D warnings`, then `pnpm check`

## Dependencies

T003 blocks all. US1 before US2 (scope feeds dependencies). US4 needs only T003 and T009.
T018 and T019 need specs 001 and 002.
