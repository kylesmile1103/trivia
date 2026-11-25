# Tasks: React code generation (Vite target)

**Input**: [spec.md](spec.md), [plan.md](plan.md), LLD-05
**Depends on**: specs 001 to 004

## Phase 1: Setup

- [x] T001 Generate `packages/blueprint-compiler` with the package generator. Add `bin/trivia-blueprint.js`
- [x] T002 Create `examples/blueprint-fixture`: the refine-admin shape with the mock contract, where golden pages are type-checked
- [x] T003 Read the installed `@refinedev/core` and `@refinedev/react-table` types for `useList`, `useOne`, `useCustom`, the mutation hooks, `useGo`, `useNotification`. Note the result shapes at the top of `src/targets/vite-refine/refine-hooks.ts`

## Phase 2: Foundational

- [x] T004 Engine: tests for `replaceFile` (round trip, hash mismatch 409, missing 404, parse error 400, CRLF), then `crates/trivia_oxc_engine/src/ops/replace_file.rs`, the `Op` variant, the napi and HTTP pass-through, the `docs/api.md` example and its pin in `tests/errors.rs`
- [ ] T005 Extract the page generator interface from `src/refine/scaffold.ts` (contract, facts and options in, code out). Plugin suite unchanged and green
- [ ] T006 [P] `src/ir.ts` and `src/facts.ts`
- [ ] T007 [P] `src/print/imports.ts` and `src/print/style.ts` (semicolons and quotes from facts), with tests

## Phase 3: User Story 1 - Contract pages (P1)

- [ ] T008 [US1] Equality test: `compilePage` for a default `list`, `create`, `edit`, `show` equals `refine/pages/plan` output
- [ ] T009 [US1] `src/contract-pages.ts`: call the generator with the blueprint's options
- [ ] T010 [US1] Generator options `filters`, `rowActions`, `headerActions`, with plugin tests and `tsc`

## Phase 4: User Story 2 - Custom pages (P1)

- [ ] T011 [US2] Golden fixture 1 (static nodes, intrinsic elements, `className`), then `lower/jsx.ts` and `print/jsx.ts`, `print/module.ts`
- [ ] T012 [US2] Golden fixture 2 (state and exposed values), then `lower/names.ts` and the value and change wiring
- [ ] T013 [US2] Golden fixture 3 (queries, bindings on query fields), then `lower/scope.ts`, `lower/queries.ts`, `targets/vite-refine/refine-hooks.ts`
- [ ] T014 [US2] Golden fixture 4 (every action step, including `call` with its handler stub), then `lower/actions.ts`
- [ ] T015 [US2] Golden fixture 5 (`when`, `each`, slots with wrapper parts)
- [ ] T016 [US2] Gate tests: every golden page parses with the engine, `tsc` passes in `examples/blueprint-fixture`, no `@trivia/*` import, determinism over shuffled input (SC-002)
- [ ] T017 [US2] Edge cases: identifier clashes, page name clashing with a file, quote and semicolon styles

## Phase 5: User Story 3 - Preview (P1)

- [ ] T018 [US3] `src/blueprint/preview.ts` in the plugin: serve `compilePage` at `/@trivia/preview/<id>.tsx`, reuse the preview stylesheet, register `/__blueprint/<Name>` in dev, invalidate on store changes
- [ ] T019 [US3] Tests: `POST /blueprint/preview` result, the module compiles under Vite, 422 with diagnostics for an invalid page
- [ ] T020 [US3] MCP `trivia_blueprint_preview`, replacing the stub of spec 004

## Phase 6: User Story 4 - Eject and the lock (P1)

- [ ] T021 [US4] `src/lock.ts` and `src/eject.ts` with unit tests for each rule: new file, unchanged file (`replaceFile`), edited file (409), missing component (422), foreign route or file (409)
- [ ] T022 [US4] Route and resource registration through the shared helpers of the new-resource tool
- [ ] T023 [US4] `src/blueprint/plan.ts`, `POST /blueprint/plan` and `/blueprint/ejected` (lock written in the same history entry)
- [ ] T024 [US4] Plugin test on a copy of the example: plan, batch, undo restores every byte and the lock, redo
- [ ] T025 [US4] MCP `trivia_blueprint_eject` as one `Agent:` entry, with a test using `trivia_undo`
- [ ] T026 [US4] Best-effort `nav` and theme token edits with warnings when anchors are missing

## Phase 7: User Story 5 - CLI and template (P2)

- [ ] T027 [US5] `templates/vite-refine/` from the fixture app's shape, without component sources
- [ ] T028 [US5] `src/cli.ts`: `validate`, `compile`, `eject --dry-run`, `new`, with exit codes 0, 1, 2 and tests in `test/cli.test.ts`

## Phase 8: Polish

- [ ] T029 `e2e/blueprint.spec.ts`: preview in the canvas, eject, select and edit an ejected element (SC-004), undo. Extend `e2e/blueprint-mcp.spec.ts` with preview, screenshot, eject
- [ ] T030 [P] `docs/api.md` and `docs/mcp.md`: complete the preview, plan and eject entries
- [ ] T031 Update LLD-05 where the implementation refined it. Decide its open point on `nav` and theme
- [ ] T032 Run `pnpm check` and `pnpm e2e`

## Dependencies

T004 and T005 are independent of each other and block Phases 3 and 6. Phase 4's fixtures build
on each other in order. Preview (Phase 5) needs Phase 4's first fixture. Eject (Phase 6) needs
T004. The CLI needs eject.
