# Tasks: Blueprint agent surface

**Input**: [spec.md](spec.md), [plan.md](plan.md), LLD-04
**Depends on**: specs 001, 002, 003

## Phase 1: Setup

- [x] T001 Verify how `restoreFiles` treats non-source paths (read `crates/trivia_oxc_engine/src/workspace.rs` and its tests). Record the answer in LLD-04 section 1
- [x] T002 Add `blueprintDir` to `AstLocatorOptions` (`src/options.ts`), default `blueprint`, resolved inside the root

## Phase 2: Foundational

- [x] T003 Tests for `writeDocuments` in `test/blueprint-service.test.ts`: writes inside the queue, `before` mismatch is 409, a failure writes nothing, one history entry, undo and redo restore bytes, undo after a hand edit is refused
- [x] T004 `EngineService.writeDocuments` in `src/api/service.ts` (and `history.ts` per T001)
- [x] T005 `src/blueprint/store.ts` and `context.ts`: the store over the directory, the validation context from `components()`, the contract manifest and the napi expression functions

## Phase 3: User Story 1 - Authoring (P1)

- [x] T006 [US1] Tests for `GET /blueprint`, `/blueprint/doc`, `/blueprint/components` on the example copy, including `exists: false`
- [x] T007 [US1] `src/blueprint/summary.ts` and the three read routes in `index.ts`, registered from `src/api/http.ts`
- [x] T008 [US1] Tests for `POST /blueprint/patch`: create a page, diagnostics in the result, directory created on first patch
- [x] T009 [US1] The patch route: store apply, `writeDocuments`, `PatchResult` with the fresh summary and `next`
- [x] T010 [US1] MCP `trivia_blueprint_get` and `trivia_blueprint_patch` in `src/mcp/tools.ts`, input schema generated from the zod ops, per-tool error advice
- [x] T011 [US1] MCP tools-list snapshot test, and a scripted client test that reaches zero errors on a two-page blueprint

## Phase 4: User Story 2 - Conflicts (P1)

- [x] T012 [US2] Tests: two patches from one read, a hand edit between read and patch, a three-document batch with one stale revision. Then the `error.details.revs` payload

## Phase 5: User Story 3 - Undo (P1)

- [x] T013 [US3] Test `trivia_blueprint_patch` then `trivia_undo` with the same label, and the labelled entry in `trivia_get_selection`'s history

## Phase 6: User Story 5 - Guard (P1)

- [x] T014 [US5] Guard tests for every blueprint route, direct and through the designer proxy (`packages/designer/server/api-guard.test.ts`), and `path_outside_root`

## Phase 7: User Story 4 - Preview, eject, backend stubs (P2)

- [ ] T015 [US4] Routes `preview`, `plan`, `ejected`, `backend` and tools `trivia_blueprint_preview`, `_eject`, `_backend`, answering 422 `unsupported` with a clear message until specs 005 and 009 fill them in. Types in place

## Phase 8: Polish

- [ ] T016 [P] `docs/api.md`: the blueprint section with an example per route, pinned by a test as the op examples are
- [ ] T017 [P] `docs/mcp.md`: the five tools and the authoring loop
- [ ] T018 `e2e/blueprint-mcp.spec.ts`: patch and undo through a browser-run MCP client (preview and eject steps added by spec 005)
- [ ] T019 Real-session check with Claude Code (SC-001). Fix what it trips on. Note it in `docs/mcp.md`
- [ ] T020 Run `pnpm check` and `pnpm e2e`

## Dependencies

T001 before T003. T004 and T005 block every story. US2, US3 and US5 depend on US1's patch
route. T015 is completed by spec 005 (preview, plan, ejected) and spec 009 (backend).
