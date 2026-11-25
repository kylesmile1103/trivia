# Feature Specification: Aspire solution and contract loop

**Feature Branch**: `010-aspire-solution-contract-loop`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 2
**Input**: The generated backend and frontend run together with one command, and a change to
the model reaches the pages through the OpenAPI contract. (BR-09)

## User Scenarios & Testing

### User Story 1 - Run everything with one command (Priority: P1)

**Independent Test**: An Aspire integration test starts the AppHost and calls the API.

**Acceptance Scenarios**:

1. **Given** a generated solution, **When** `aspire run` is started, **Then** PostgreSQL
   starts, migrations are applied, the API reports healthy, the web dev server starts, and the
   dashboard shows all four with logs and traces.
2. **Given** the API project alone, **When** it starts, **Then** it does not migrate the
   database itself.

### User Story 2 - The web app talks to the API (Priority: P1)

**Acceptance Scenarios**:

1. **Given** the solution running, **When** the browser requests `/api/v1/customers`, **Then**
   the web dev server proxies it to the API, with no CORS configuration anywhere.
2. **Given** a list page with paging, a sort and a filter, **When** it loads, **Then** the data
   provider sends `page`, `pageSize`, `sort` and `filter` as LLD-09 defines, and shows `items`
   and `total`.
3. **Given** a create form sending an invalid value, **When** the API answers 400, **Then** the
   message appears on that form field.
4. **Given** the web app started without Aspire, **Then** it uses `API_URL`, or fails the
   first request with a message that says which variable to set.

### User Story 3 - The contract flows (Priority: P1)

**Acceptance Scenarios**:

1. **Given** the API project, **When** it is built, **Then** `web/openapi/api.openapi.json` is
   written.
2. **Given** that document, **When** `pnpm sync` runs in `web/`, **Then** the typed client and
   `trivia.manifest.json` are regenerated, with one resource per entity, all five operations,
   `listItemsPath: "items"` and page pagination, without manual overrides.
3. **Given** a field removed from the model and the loop run again, **When** drift is listed,
   **Then** each page that used the field has an issue with a fix.

### User Story 4 - One command for the loop (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a changed model, **When** `trivia-blueprint backend --migration AddNotes` runs,
   **Then** it generates, adds the migration, builds, syncs, and prints the drift summary,
   stopping at the first failing step with that step's output.
2. **Given** an agent, **When** it calls `trivia_blueprint_backend`, **Then** the result's
   `next` names the remaining steps and the tools for them.

### User Story 5 - Publish (Priority: P3)

**Acceptance Scenarios**:

1. **Given** the solution, **When** `aspire publish` runs for Docker Compose, **Then** the
   compose file names the database, the migration job, the API and the web app.

### Edge Cases

- No container runtime on the machine.
- The API is rebuilt while the web dev server is running.
- A resource whose plural differs from the entity name by more than an `s`.
- The web folder is not next to `src/`.

## Requirements

Full text in `docs/blueprint/SRS.md` section 3.10: **FR-AS-01** to **FR-AS-09**.

### Key Entities

- **AppHost**, **ServiceDefaults**, **MigrationService** (scaffold projects). The **data
  provider** and **dev proxy** (scaffold files in the web app). The committed **OpenAPI
  document**.

## Success Criteria

- **SC-001**: The Aspire integration test passes: API healthy, CRUD through its HTTP client.
- **SC-002**: The contract test passes: fixture model to OpenAPI to manifest, with no overrides.
- **SC-003**: The data provider test passes every operator against the real API.
- **SC-004**: From a changed model to a drift list takes one command.

## Assumptions and out of scope

- A C# AppHost. Kubernetes and Azure publishing are Aspire's own and untested here.
- The web app's `sync` uses contract-sync as it is.
