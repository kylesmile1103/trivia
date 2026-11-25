# Tasks: MVP slice

**Input**: [spec.md](spec.md), [plan.md](plan.md)
**Depends on**: specs 001 to 010

## Phase 1: Setup

- [x] T001 Write `examples/blueprint-mvp/blueprint/`: the app document, the model (Customer, Account, two enums, `approveKyc`), five pages with their options and two actions. It must validate
- [x] T002 `examples/blueprint-mvp/README.md` with the commands, and `PROMPT.md` with the one-paragraph agent prompt

## Phase 2: User Story 1 - Blueprint to running solution (P1)

- [x] T003 [US1] `tools/blueprint/mvp.test.mjs`: temp folder, `new`, copy the blueprint and the committed kit, `backend --migration Initial`, `eject`, `dotnet build -warnaserror`, `tsc`. Skips with a message when the .NET SDK or a container runtime is missing
- [x] T004 [US1] Fix each failure in its owning spec with a regression test there. List them in this file under "Found by the slice"
- [x] T005 [US1] Extend the script: start the AppHost through the Aspire testing host, create a customer through the API, read it back from the list
- [x] T006 [US1] `e2e/blueprint-mvp.spec.ts` and a Playwright project: list, filter by status, create, a field error from the API, the Approve KYC action answering 501

## Phase 3: User Story 2 - Edit with Trivia (P1)

- [x] T007 [US2] In the e2e spec, through the designer: add `creditLimit` with the columns tool, add `notes` with the form-fields tool, change a button variant. Assert the changed lines and byte-exact undo for each
- [x] T008 [US2] Assert that ejecting an edited page again is refused with `conflict`

## Phase 4: User Story 3 - Model change and drift (P1)

- [x] T009 [US3] In the script: patch the model (add `segment`, remove `notes`), run `backend --migration Segment`, assert the backend diff is `.g.cs` files plus one migration, assert the drift list
- [x] T010 [US3] Apply the fix and add the column through the plugin API. `tsc` passes

## Phase 5: User Story 4 - Agent (P1)

- [ ] T011 [US4] Run the prompt in a fresh Claude Code session with only the Trivia server, twice. Save both transcripts' tool-call lists under `examples/blueprint-mvp/sessions/`
  Deferred: the lead runs the prompt in Claude Code
- [x] T012 [US4] Fix what the agent tripped on (tool descriptions, hints, diagnostics) in specs 001 to 005. Note it in `docs/mcp.md`

## Phase 6: Close-out

- [x] T013 Measure SC-004 and SC-005. Record them in `docs/blueprint/README.md`
- [x] T014 Add the slice to the release checklist: `tools/release` runs it before tagging
- [ ] T015 Update `docs/HANDOFF.md` (status, catches) and `docs/product.md` (day 1 is in, with a link to the BRD), and review the ⚑ decisions with the owner

## Found by the slice

- Spec 005: list header refetch had no contract query target. Regression:
  `packages/vite-plugin-ast-locator/test/blueprint-codegen.test.ts` (current table query).
- Spec 005: a generated Vite project failed `tsc` on the entry import and the linked
  plugin's Vite types. Regressions: `packages/blueprint-compiler/test/scaffold-typecheck.test.ts`,
  `packages/blueprint-compiler/test/template.test.ts`, and the scripted standalone build.

- Spec 005: the table clipped custom row actions beside stock buttons, and handled form
  errors leaked as unhandled rejections. Regression: the custom-row and form-submit
  cases in `packages/vite-plugin-ast-locator/test/blueprint-codegen.test.ts`.
- Spec 005: the Vite scaffold had no notification provider, so the KYC error was invisible.
  Regressions: `packages/blueprint-compiler/test/template.test.ts` and the 501 browser case.

- Spec 009: an enum used only in nullable fields emitted an empty OpenAPI schema, so the
  segment column rendered JSON. Regression: `dotnet/tests/Trivia.Blueprint.Codegen.Tests/OpenApiTests.cs`
  (nullable enum wire values) and the regenerated API browser case.

- Specs 004 and 005: the patch response did not say which operation ID contract sync
  published and did not flag a mistyped list-header refetch. Regression:
  `packages/dev-service/test/blueprint-mcp.test.ts` (synced mutation ID and implicit list query).

## Dependencies

Strictly ordered by phase. T004 loops with T003 until the script passes.
