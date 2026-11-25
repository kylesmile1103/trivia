# Tasks: Component kit

**Input**: [spec.md](spec.md), [plan.md](plan.md), LLD-06
**Depends on**: specs 002 and 005

## Phase 1: Setup

- [x] T001 Create `examples/blueprint-kit` from `templates/vite-refine`, install the 25 shadcn items and the refine-ui items with the shadcn CLI, commit the result. Mock contract with Customer, Account, Transaction
- [x] T002 `tools/blueprint/check-kit-manifests.cjs`: for each manifest, assert its `valueProp`, `changeProp`, events and parts exist in the installed component source (via `@trivia/engine` `components()`)
- [x] T003 A test that lists `kit/*.manifest.json` and fails when a type has no page in `fixtures/kit/` (SC-001)

## Phase 2: Foundational

- [x] T004 Expose the column snippet builders (`src/refine/columns.ts`) and the field, rule and default builders (`fields.ts`, `rules.ts`) through the generator interface. Plugin suite unchanged

## Phase 3: User Story 1 - The 25 components (P1)

- [x] T005 [P] [US1] Actions and display: `Button`, `DropdownMenu`, `Badge`, `Avatar`, `Alert`, `Tooltip`, `Skeleton`, `Breadcrumb`, `Empty`. Manifests, fixture page, golden
- [x] T006 [P] [US1] Inputs: `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `RadioGroup`, `Combobox`, `DatePicker`, `Label`, `Field`. Each exposed value bound in the fixture page
- [x] T007 [P] [US1] Containers: `Card`, `Tabs`, `Dialog`, `Sheet`, `Popover`, `Separator`, with slot parts and `open` exposure
- [x] T008 [US1] `tsc` over the golden pages in `examples/blueprint-kit`, and the manifest check (T002) in the package's test target

## Phase 4: User Story 2 - DataTable (P1)

- [x] T009 [US2] Golden for a `DataTable` page, then `src/composites/data-table.ts`: `useTable`, columns from the shared builders, the refine-ui table element
- [x] T010 [US2] `selectable` with `selectedRow` and `selectedRows` exposure, and a binding test
- [x] T011 [US2] Plugin test: the columns tool adds, reorders and removes a column on the emitted page (SC-004)

## Phase 5: User Story 3 - Form (P1)

- [x] T012 [US3] Golden for a `Form` page in both styles, then `src/composites/form.ts`: schema, defaults, controls, layout, redirect
- [x] T013 [US3] Plugin tests: the form-fields tool adds a field, and drift fixes a changed bound, on the emitted page (SC-004)

## Phase 6: User Story 4 - Limits (P2)

- [x] T014 [US4] `kit/deferred.json` and the `unknown_component` hint. Fixture and test

## Phase 7: Base UI

- [ ] T015 Base UI variants in the manifests. A second example configuration (or a fixture set of component sources) for the check script and `tsc` (SC-002)

## Phase 8: User Story 5 - Virtual rows (P3)

- [ ] T016 [US5] `virtual` with TanStack Virtual for client-side sets, the warning with server paging, a render test with 5 000 rows

## Phase 9: Polish

- [ ] T017 `e2e/blueprint-kit.spec.ts`: eject all fixture pages, load each route, no console errors, type into an input, sort and filter the table, submit the form
- [ ] T018 Accessibility pass on the form and table pages (labels, keyboard) for NFR-13
- [ ] T019 Update LLD-06 with the final manifest list and any type that moved to deferred
- [ ] T020 Run `pnpm check` and `pnpm e2e`

## Dependencies

T001 and T002 block Phase 3. T004 blocks Phases 4 and 5. The three groups of Phase 3 are
parallel. Base UI (Phase 7) follows Phase 3.
