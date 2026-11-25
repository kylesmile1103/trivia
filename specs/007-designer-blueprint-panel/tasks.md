# Tasks: Designer Blueprint panel

**Input**: [spec.md](spec.md), [plan.md](plan.md), LLD-07
**Depends on**: spec 004 (routes), spec 005 (preview, plan). Phase 2 tasks need specs 008 to 010

## Phase 1: Setup

- [x] T001 Mirror the LLD-04 types in `packages/designer/src/shared/engine/types.ts` and add the client functions (summary, doc, components, patch, preview, plan, ejected, backend)
- [x] T002 Move the Layers drop rules to `src/shared/lib/tree-drop.ts`. Layers tests and `architecture.test.ts` green

## Phase 2: Foundational

- [x] T003 `features/blueprint/store.ts` and `api.ts`: summary, open document with its revs, patch with conflict handling. Unit tests with a fake client
- [x] T004 The tab in `app/LeftPanel.tsx` with icons and tooltips, and `features/blueprint/index.ts`

## Phase 3: User Story 1 - Pages (P1)

- [x] T005 [US1] `PagesList.tsx` with status chips, counts and empty states. Tests
- [x] T006 [US1] `PageForm.tsx` for contract kinds: resource from the contract, fields, title, filters, actions. One labelled patch per change. Tests per kind
- [x] T007 [US1] `Diagnostics.tsx`: the list, each entry focusing its field

## Phase 4: User Story 2 - Preview and eject (P1)

- [x] T008 [US2] Preview: call the route, `canvas.navigate`, the draft banner
- [ ] T009 [US2] `EjectDialog.tsx`: the 422 branch with the command to copy, the plan listing, confirm through `dispatch` then `POST /blueprint/ejected`, then navigate to the real route. Tests for both branches
- [ ] T010 [US2] Statuses `ejected` and `edited` with their actions and the "code is the truth" note

## Phase 5: User Story 4 - Other writers (P1)

- [ ] T011 [US4] Conflict flow: reload, report, no retry. Re-read on window focus and after history changes. Tests

## Phase 6: User Story 3 - Custom pages (P2)

- [ ] T012 [US3] `NodeTree.tsx` over the flat maps with the shared drop rules, add from manifests (not-installed types marked), remove
- [ ] T013 [US3] `ExpressionInput.tsx` showing a diagnostic at its UTF-16 span
- [ ] T014 [US3] `NodeProps.tsx`: editors by prop kind, the static or binding toggle, events and exposed names. Time-box moving the inspector's widgets to `shared/components/`

## Phase 7: e2e (Phase 1 exit)

- [ ] T015 `e2e/blueprint.spec.ts`: create a contract page, preview, eject, undo, a custom page with a bound input, a conflict from a concurrent patch
- [ ] T016 Keyboard and label pass (SC-004)
- [ ] T017 Run `pnpm check` and `pnpm e2e`

## Phase 8: User Story 5 - Model editor (Phase 2)

- [ ] T018 [US5] `ModelEditor.tsx`: entity list, field grid, relations, API options, each edit a model op, inline diagnostics with fix buttons. Tests

## Phase 9: User Story 6 - Backend (Phase 2)

- [ ] T019 [US6] `BackendDialog.tsx`: plan table, migration name, confirm, next steps, the missing-`dotnet` message. Tests
- [ ] T020 e2e: edit the model, plan the backend, see the file table

## Phase 10: User Story 7 - Select from a preview (P3)

- [ ] T021 [US7] `data-bp-node` in preview modules only (compiler flag), click to select in the tree

## Dependencies

T001 to T004 block every story. US2 needs spec 005's preview and plan. Phases 8 and 9 wait
for Phase 2 of the roadmap. T021 is optional.
