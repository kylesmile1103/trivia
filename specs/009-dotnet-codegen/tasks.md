# Tasks: .NET code generation

**Input**: [spec.md](spec.md), [plan.md](plan.md), LLD-09
**Depends on**: spec 008 (schema, fixture, mapping fixture)

## Phase 1: Setup

- [x] T001 Create `dotnet/` with `Trivia.Blueprint.slnx`, `Directory.Packages.props`, the tool project (packed as `trivia-dotnet`) and the test project. Add `dotnet/project.json` so Nx runs `dotnet build` and `dotnet test`
- [ ] T002 Verify against current documentation and note in LLD-09: minimal API validation setup, build-time OpenAPI document generation properties, typed results and OpenAPI, Npgsql enum and `xmin` mappings
- [ ] T003 A build step that copies `packages/blueprint/fixtures/model/` into the test project's `Fixtures/`

## Phase 2: Foundational

- [ ] T004 `Model/`: records for `model.v1.json` and `app.v1.json`, `ModelLoader` with the version check. Test: the bank fixture deserializes without loss
- [ ] T005 [P] `Mapping/TypeMap` with a test against `model-mapping.json`
- [ ] T006 Tests for ownership in `PlanWriterTests`: create, update, unchanged, hand-edited generated file refused (exit 2), `--force`, scaffold never rewritten, removed entity, path escape refused, refusal writes nothing
- [ ] T007 `Plan/`: `FilePlan`, `Hashing` (header and body hash), `PlanWriter` (atomic, all-or-nothing)
- [ ] T008 `Commands/`: `plan` (JSON on stdout, `--content`), `write`, `check`, with exit codes

## Phase 3: User Story 1 - A working API (P1)

- [ ] T009 [US1] Snapshot tests, then `EntityEmitter`, `EnumEmitter` (with literal-value converters), `DbContextEmitter`
- [ ] T010 [US1] Scaffold text: `Program.cs`, the API csproj, the solution file, entity and context partials
- [ ] T011 [US1] Build test: write the bank fixture to a temp folder, `dotnet build -warnaserror`
- [ ] T012 [US1] Snapshot tests, then `ContractsEmitter` (records with validation attributes) and `EndpointsEmitter` for get, create, update, delete with typed results
- [ ] T013 [US1] `ApiProblemEmitter` and `ApiRegistrationEmitter` (context, validation, OpenAPI, problem details, exception handler, group mapping)
- [ ] T014 [US1] Integration suite with PostgreSQL in a container: CRUD statuses and bodies, validation 400 with `errors`, 404, unique 409

## Phase 4: User Story 2 - Lists (P1)

- [ ] T015 [US2] Integration tests for paging, sorting, each filter operator per field type, `q`, and each 400 case
- [ ] T016 [US2] `ListQueryEmitter`: shared parsing, per-entity `switch` for filter and sort, the page record

## Phase 5: User Story 3 and 4 - Regeneration and review (P1)

- [ ] T017 [US3] End-to-end test: write, implement a hook in a scaffold file, change the model, write again. Hook file untouched, second identical run all `unchanged`
- [ ] T018 [US4] `check` test on a stale tree, and a determinism test (two runs, identical bytes)

## Phase 6: User Story 5 - Extension points (P1)

- [ ] T019 [US5] Partial-method hooks in the endpoints emitter and the scaffold half. Integration test with a rejecting `OnCreating` and a scoping `ConfigureQuery`
- [ ] T020 [US5] Custom operations: generated route and partial declaration, one scaffold stub file per operation returning 501, `todo` entries in the plan. Integration test before and after implementing

## Phase 7: User Story 6 - Contract (P1)

- [ ] T021 [US6] Operation ids, tags and schema names per LLD-09 section 4. A test that builds the document twice and compares, and a snapshot of the bank fixture's document

## Phase 8: User Story 7 - Migrations (P2)

- [ ] T022 [US7] `migrate <Name>`: run `dotnet ef migrations add` with an argument array, never touch older migrations
- [ ] T023 [US7] `Migrations/RenameRewriter`: turn a matching drop and add pair into a rename in the migration this run created. Tests on sample migration files

## Phase 9: User Story 8 - Auth (P3)

- [ ] T024 [US8] `auth.mode: "oidc"` in `ApiRegistrationEmitter`: JWT bearer from configuration, groups require authorization, OpenAPI security scheme. Integration test with a test token

## Phase 10: Polish

- [ ] T025 [P] Optional `concurrency: true`: row version, `version` in contracts, 409 `stale`
- [ ] T026 [P] Performance test for SC-004 with a generated 50-entity model
- [ ] T027 Edge cases: non-identifier enum values, self-relations, empty model, newer blueprint version
- [ ] T028 Fill `src/blueprint/backend.ts` in the plugin: run `trivia-dotnet` with an argument array and a timeout, map its JSON to `BackendResult`, the missing-`dotnet` message. Replace the stub of spec 004 and its MCP tool
- [ ] T029 Update LLD-09 with verified API names. Run `dotnet test` (all traits) and `pnpm check`

## Dependencies

T004 to T008 block every story. US2 and US5 build on US1's endpoints. US7 needs a buildable
solution. T028 needs spec 004.
