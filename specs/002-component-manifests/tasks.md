# Tasks: Component manifests

**Input**: [spec.md](spec.md), [plan.md](plan.md), LLD-02
**Depends on**: spec 001 (T023, the validation context)

## Phase 1: Setup

- [x] T001 `tools/blueprint/refresh-analyzer-fixture.cjs`: write `fixtures/manifests/analyzer/refine-admin.components.json` from `@trivia/engine` `components()`
- [x] T002 [P] Sample manifests for `Button`, `Input`, `Card` in `fixtures/manifests/kit-sample/`

## Phase 2: Foundational

- [x] T003 `src/manifest/types.ts`: the zod schema and types, including per-base variants
- [x] T004 [P] `src/manifest/intrinsics.ts` with the tag list and props of LLD-02 section 3

## Phase 3: User Story 1 - Validate against the real component (P1)

- [x] T005 [US1] Resolver tests: kit and installed (analyzer props win), with the `brand` variant case
- [x] T006 [US1] `src/manifest/resolve.ts`: merge order, import path from aliases
- [x] T007 [US1] `src/manifest/check.ts`: `unknown_component`, `unknown_prop`, `invalid_prop_value`, slot checks. Fixtures per code
- [x] T008 [US1] Register the layer in `validate()` through the context

## Phase 4: User Story 2 - Missing components (P1)

- [x] T009 [US2] Test and implement `installed: false` and the `missing_component` diagnostic with its registry hint

## Phase 5: User Story 3 - Events and exposed values (P1)

- [x] T010 [US3] `unknown_event` and the change-prop binding refusal, with fixtures
- [x] T011 [US3] Export `exposedScope(page, manifests)`: the `ui` root for spec 003's scope

## Phase 6: User Story 4 - Local components and HTML (P2)

- [x] T012 [US4] Derived manifests for analyzer-only components
- [x] T013 [US4] Overrides from `blueprint/manifests/`, with the "annotates a missing prop" diagnostic
- [x] T014 [US4] Intrinsic types in the resolver and the checks

## Phase 7: User Story 5 - JSON Schema (P3)

- [x] T015 [US5] `src/manifest/json-schema.ts` with snapshot tests

## Phase 8: Polish

- [ ] T016 Edge cases: missing `components.json`, duplicate export names, Base UI variant selection
- [ ] T017 Run `pnpm check`

## Dependencies

T003 blocks all. US2 to US4 each build on the resolver of US1. T011 is needed by spec 003's
integration and by spec 005.
