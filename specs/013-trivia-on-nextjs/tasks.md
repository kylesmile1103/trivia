# Tasks: Trivia on Next.js

**Input**: [spec.md](spec.md), [plan.md](plan.md), LLD-13
**Depends on**: nothing in the blueprint track. It can start any time after Phase 0's adapter exists, since that adapter moves too

## Phase 1: User Story 1 - Spike (P1)

- [x] T001 [US1] In a scratch App Router app on the Next.js version to pin: answer the six questions of LLD-13 section 1 with a minimal loader calling `@trivia/engine` `annotate`. Write each answer into LLD-13
- [x] T002 [US1] If a question fails with Turbopack, try the Babel loader, then the SWC plugin. Record the outcome as an ADR superseding ADR-0015 when it differs
- [x] T003 [US1] Read how the designer learns that the canvas re-rendered (`packages/designer/src/features/canvas`). Note whether it depends on Vite's HMR socket

## Phase 2: User Story 2 - Extract the dev service (P1)

- [x] T004 [US2] Generate `packages/dev-service`. Move `api/`, `mcp/`, `refine/`, `blueprint/`, `routes/`, `engine.ts` and their tests with `git mv`, content unchanged, imports fixed. `pnpm check` and `pnpm e2e` green
- [x] T005 [US2] `src/host.ts`: the `DevHost` interface. The Vite plugin implements it (module resolution, routes, virtual-module previews) and mounts the handlers. Suites green without changed assertions (SC-002)
- [ ] T006 [US2] `src/stamp.ts`: the insertion and source-map code out of `transform.ts`, used by the plugin
- [ ] T007 [US2] `src/standalone.ts` and `bin/trivia-dev.js`: loopback only, a chosen port, the same guard. Guard tests and a smoke subset of the API and MCP suites through it

## Phase 3: User Story 3 - Stamp and edit (P1)

- [ ] T008 [US3] Generate `packages/next`. `src/loader.cjs` over `stamp.ts`. Test: the engine's locator fixtures through the loader equal the Vite transform's output (SC-003)
- [ ] T009 [US3] `src/with-trivia.ts`: development only, `.tsx` and `.jsx` outside `node_modules` and the preview folder, for Turbopack and for webpack. Unit tests on the produced config per phase
- [ ] T010 [US3] The designer's proxy: a second target for `/@trivia/api` and `/@trivia/mcp`, guard first. Tests in `packages/designer/server/`
- [ ] T011 [US3] `src/launcher.ts` and `bin/trivia-next.js`: start `next dev` and the dev service, print the MCP URL, stop both, clean preview files
- [ ] T012 [US3] `examples/next-admin`: the refine-admin pages on App Router with one server component page, `withTrivia` in its config
- [ ] T013 [US3] If T003 found a Vite dependency: the host-neutral re-render signal, with the existing e2e projects still green
- [ ] T014 [US3] `e2e/next/edit.spec.ts` and the third Playwright project: select, inspect, `updateProp`, `setText` in a server component, insert, move, remove, undo and redo

## Phase 4: User Story 4 - Pages and Refine tools (P2)

- [ ] T015 [US4] `packages/next/src/host.ts` `readRoutes`: `app/**/page.{tsx,jsx}`, route groups, dynamic and catch-all segments, skipped kinds, Refine labels. Unit tests on a fixture tree
- [ ] T016 [US4] The Refine adapter's route registration by `DevHost.kind`. e2e: the Pages tab and the columns tool on the example

## Phase 5: User Story 5 - Agents (P2)

- [ ] T017 [US5] MCP through the launcher's URL: the tools list equals the Vite one. A scripted client test

## Phase 6: User Story 6 - Never in production (P1)

- [ ] T018 [US6] A test that runs `next build` on the example and greps the output for `data-ast-node` and for `@trivia` (SC-005)

## Phase 7: Polish

- [ ] T019 Edge cases: a `pages/`-only app (empty list and a note), webpack mode, the React Compiler on, Windows separators, port clashes
- [ ] T020 Docs: `README.md` "Using Trivia in your own Next.js app", `docs/architecture.md` (the new packages), `docs/api.md` (the dev service host), `CLAUDE.md` layout section
- [ ] T021 Run `pnpm check` and all three Playwright projects

## Dependencies

T001 decides the loader's form before T008. T004 before T005, each followed by the full gate.
T007 and T008 to T011 block the example and its e2e. Phase 4 needs Phase 3.
