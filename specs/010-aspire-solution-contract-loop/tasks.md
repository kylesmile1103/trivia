# Tasks: Aspire solution and contract loop

**Input**: [spec.md](spec.md), [plan.md](plan.md), LLD-10
**Depends on**: spec 009 (the API), spec 005 (templates, CLI)

## Phase 1: Setup

- [x] T001 Read the Aspire documentation for the version to pin: PostgreSQL resource, project references, wait-for and wait-for-completion, the Vite and JavaScript app resources, service discovery variables, the testing package. Note names and versions in LLD-10
- [x] T002 Read the .NET documentation for build-time OpenAPI document generation. Note the properties in LLD-10

## Phase 2: Foundational

- [x] T003 Scaffold text for `AppHost`, `ServiceDefaults` and `MigrationService` in `Scaffold/`, added to the file plan as scaffold files and to the solution file
- [x] T004 Extend the build test: the whole generated solution builds, AppHost included

## Phase 3: User Story 1 - One command (P1)

- [x] T005 [US1] `MigrationService/Worker.cs`: migrate inside an execution strategy, then stop. The API waits for completion and never migrates
- [x] T006 [US1] `Integration/AppHostTests.cs` with `Aspire.Hosting.Testing`: start without the web app, wait for the API to be healthy, run CRUD through its client. Trait for the container runtime

## Phase 4: User Story 3 - The contract flows (P1)

- [x] T007 [US3] API csproj properties so the build writes `web/openapi/api.openapi.json`. Test in the build test
- [x] T008 [US3] `test/contract-loop.test.ts`: the bank fixture's OpenAPI snapshot through contract-sync gives a manifest with one resource per entity, five operations, `listItemsPath: "items"`, page pagination, and no overrides
- [x] T009 [US3] The `sync` script in the template's `package.json`
- [x] T010 [US3] Drift test: remove a field from the model fixture, rerun generation and sync on a copy, assert `refine/drift` lists the pages with fixes

## Phase 5: User Story 2 - The web app talks to the API (P1)

- [x] T011 [US2] Unit tests for the data provider's request building (pagination, sorters, each filter operator, `getMany`, custom) and error mapping, then `templates/vite-refine/src/providers/data-provider.ts`
- [x] T012 [US2] A Node script in the integration run that drives the data provider against the real API: list with paging, sort and each operator, one validation error mapped to fields
- [x] T013 [US2] The `/api` proxy in the template's `vite.config.ts` from the service discovery variables, the `API_URL` fallback and the clear error. Unit test of the config function

## Phase 6: User Story 4 - One command for the loop (P2)

- [ ] T014 [US4] `trivia-blueprint backend [--migration <Name>]`: write, migrate, build, sync, drift summary, stopping at the first failure. Child processes with argument arrays. Tests with fake executables
- [ ] T015 [US4] Write the last generated model revision and field summary into the lock (spec 008 T011)
- [ ] T016 [US4] `trivia_blueprint_backend`'s `next` field names build, `trivia_sync_openapi` and `trivia_contract_drift`

## Phase 7: User Story 5 - Publish (P3)

- [ ] T017 [US5] A Docker Compose environment in the AppHost scaffold. A test that runs the publish and checks the compose file names four services

## Phase 8: Polish

- [ ] T018 A getting-started section in `docs/blueprint/README.md` with the five commands of LLD-10 section 4
- [ ] T019 Edge cases: no container runtime (a clear message), irregular plurals, a web folder elsewhere
- [ ] T020 Run `dotnet test` (all traits), `pnpm check`

## Dependencies

T001 and T002 first. T003 and T004 block the rest. US3 needs spec 009's contract task (T021).
US2's integration task needs US1's AppHost test.
