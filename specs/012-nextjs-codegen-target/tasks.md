# Tasks: Next.js code generation target

**Input**: [spec.md](spec.md), [plan.md](plan.md), LLD-12
**Depends on**: specs 005, 006, 010. Preview (Phase 8) also needs spec 013's spike

## Phase 1: Setup

- [x] T001 Read the current Next.js documentation (App Router file conventions, async `params` and `searchParams`, rewrites, `proxy.ts`, Cache Components) and Refine's Next.js guide (router binding, server-side data, initial data). Pin versions. Note the findings in LLD-12
- [x] T002 Build `templates/next-refine/` by hand: layout, providers, shell, `error.tsx`, `not-found.tsx`, `components.json` with `rsc: true`, the data provider, the sync script. It runs under `next dev` and `next build`

## Phase 2: Foundational

- [x] T003 `src/targets/target.ts`, and move the Vite target onto it. Every existing golden file byte-identical (SC-004)
- [x] T004 `validate` gains target-only checks behind `app.targets.web`

## Phase 3: User Story 1 - Emit for Next.js (P1)

- [x] T005 [US1] Golden files for the MVP's contract pages, then `next-refine/files.ts`: a server `page.tsx` and one client view per page
- [ ] T006 [US1] `next-refine/routes.ts`: resource registration by value op on `app/providers.tsx`, no `<Route>` ops
- [ ] T007 [US1] Eject test into a copy of the template, then `tsc`. `next build` in CI
- [ ] T008 [US1] Test: compile both fixtures for both targets from the same documents (SC-001)

## Phase 4: User Story 2 - Boundaries (P1)

- [ ] T009 [US2] Unit tests for `boundaries.ts` on small trees: shared state under a static card, a static header above a table, a fully static page, nested groups, a crossing function prop
- [ ] T010 [US2] `next-refine/boundaries.ts`: client need per node, union-find groups, lowest common ancestor, merge, crossing props, `boundary_not_serializable`
- [ ] T011 [US2] Golden files for the kit fixture's custom pages with split modules

## Phase 5: User Story 3 - Data on the server (P1)

- [ ] T012 [US3] `next-refine/server-data.ts`: await server-tier queries through the typed client with the internal API address, forward `cookie` and `authorization`, `notFound()` on 404
- [ ] T013 [US3] Initial data into the Refine hooks through `RefineHookMap`. Prefetch for `show` and `edit` contract pages
- [ ] T014 [US3] `e2e/blueprint-next.spec.ts` under the AppHost: the show page's HTML contains the record with a plain HTTP request, no immediate refetch after hydration, a missing id gives the not-found page

## Phase 6: User Story 4 - One origin (P1)

- [ ] T015 [US4] Rewrites for `/api` in the template's `next.config.ts` from the service discovery variables. The AppHost scaffold's JavaScript app branch. Test under the AppHost

## Phase 7: User Story 5 - Caching (P2)

- [ ] T016 [US5] `public_page_uses_user` validation, then `next-refine/caching.ts` for public pages only. Golden files with and without

## Phase 8: User Story 6 - Preview (P2)

- [ ] T017 [US6] `next-refine/preview.ts` and the dev service's file-based `PreviewHost`: write under `app/(blueprint-preview)/__blueprint/<Name>/`, remove on eject, on draft deletion and on stop. Tests

## Phase 9: Polish

- [ ] T018 Edge cases: catch-all routes, a failing server query reaching `error.tsx`, a server value crossing as a prop
- [ ] T019 Update LLD-12 with verified API names and the spike's outcome. Update `docs/blueprint/README.md`
- [ ] T020 Run `pnpm check`, `pnpm e2e`, and the `next build` job

## Dependencies

T003 blocks all target work. Phase 3 before Phase 4 (custom pages build on the page shape).
Phase 5 needs Phase 3. Phase 8 needs spec 013 T001 and its dev service.
