# Feature Specification: .NET code generation

**Feature Branch**: `009-dotnet-codegen`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 2
**Input**: A model document becomes an ASP.NET Core API on .NET 10 with EF Core and PostgreSQL.
Regenerating never touches hand-written code. (BR-08)

## User Scenarios & Testing

### User Story 1 - Generate a working API (Priority: P1)

**Independent Test**: Generate from the bank fixture, build with warnings as errors, run the
integration suite against PostgreSQL.

**Acceptance Scenarios**:

1. **Given** the bank model, **When** `trivia-dotnet write` runs in an empty folder, **Then**
   a solution exists that builds with `-warnaserror`.
2. **Given** the running API, **When** a customer is created, read, updated and deleted,
   **Then** the statuses are 201, 200, 200 and 204, and the bodies match the contract records.
3. **Given** a request that breaks a constraint, **Then** the answer is a 400 problem with an
   `errors` member keyed by field.
4. **Given** a duplicate value for a unique field, **Then** the answer is a 409 problem with
   `code: "unique"`.

### User Story 2 - List, sort, filter, search (Priority: P1)

**Acceptance Scenarios**:

1. **Given** 45 customers, **When** `?page=2&pageSize=20` is requested, **Then** the answer has
   20 items, `total: 45`, `page: 2`, `pageSize: 20`.
2. **Given** `sort=fullName,-createdAt`, **Then** the rows come in that order.
3. **Given** each filter operator on a field that supports it, **Then** the rows match.
4. **Given** a sort or filter on a field that is not allowed, or an unknown operator, **Then**
   the answer is a 400 problem that names it.
5. **Given** `q=ann`, **Then** rows whose searchable fields contain it, ignoring case, return.

### User Story 3 - Regenerate without losing code (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a hook implemented in `CustomerEndpoints.cs`, **When** the model changes and the
   tool runs again, **Then** the `.g.cs` files change and the hook file does not.
2. **Given** a `.g.cs` file edited by hand, **When** the tool runs, **Then** it stops with
   exit code 2, names the file and writes nothing. With `--force` it overwrites.
3. **Given** an unchanged model, **When** the tool runs again, **Then** every file is reported
   `unchanged`.
4. **Given** an entity removed from the model, **Then** its generated files are deleted and
   its scaffold files stay.

### User Story 4 - Review before writing (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a model change, **When** `plan` runs, **Then** it prints JSON listing each file
   with its kind and action, and nothing on disk changes.
2. **Given** CI, **When** `check` runs on a tree with a stale generated file, **Then** it
   exits 1 and names it.

### User Story 5 - Extend with code (Priority: P1)

**Acceptance Scenarios**:

1. **Given** `OnCreating` implemented to reject a request, **When** a create arrives, **Then**
   the answer is the problem the hook threw.
2. **Given** a custom operation `approveKyc`, **When** generated, **Then** the route exists and
   answers 501 until its stub file is implemented, and the build never breaks.
3. **Given** `ConfigureQuery` implemented to scope rows, **Then** list and get honour it.

### User Story 6 - A contract the frontend can use (Priority: P1)

**Acceptance Scenarios**:

1. **Given** the built API, **Then** its OpenAPI 3.1 document has the operation ids, tags and
   schema names of LLD-09 section 4, and they are the same on every build.

### User Story 7 - Migrations (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a model change, **When** `migrate AddNotes` runs, **Then** a new EF Core migration
   exists and no older migration changed.
2. **Given** a field with `renamedFrom`, **When** the migration is added, **Then** it renames
   the column, and the tool reports that it rewrote a drop and add pair.

### User Story 8 - Require sign-in (Priority: P3)

**Acceptance Scenarios**:

1. **Given** `auth.mode: "oidc"`, **Then** every endpoint needs a valid bearer token, and the
   OpenAPI document says so.

### Edge Cases

- An enum whose values are not C# identifiers.
- An entity with a self-relation.
- `--root` pointing outside the working tree, and a path in the plan that would escape it.
- A blueprint from a newer version.
- A model with no entities.

## Requirements

Full text in `docs/blueprint/SRS.md` section 3.9: **FR-NC-01** to **FR-NC-13**, with **NFR-02**,
**NFR-05** and **NFR-12**.

### Key Entities

- **File plan**: path, kind (generated or scaffold), action, hash. **Generated file** with
  its hash header. **Scaffold file**. The **API conventions**.

## Success Criteria

- **SC-001**: The emitted solution for the bank fixture builds with warnings as errors.
- **SC-002**: The integration suite covers every route, every list operator and every problem
  status.
- **SC-003**: Two runs give identical bytes.
- **SC-004**: Planning a 50-entity model takes under 5 seconds.
- **SC-005**: No response of the generated API contains a stack trace or SQL.

## Assumptions and out of scope

- Minimal API slices on PostgreSQL (ADR-0010). No `PATCH`. No embedded relations in responses.
- The AppHost, ServiceDefaults and MigrationService scaffolds are spec 010.
