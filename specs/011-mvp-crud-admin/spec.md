# Feature Specification: MVP slice, a CRUD admin end to end

**Feature Branch**: `011-mvp-crud-admin`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 2 (the exit of Phases 0 to 2)
**Input**: From an empty folder and one blueprint: a .NET and React solution that builds, runs,
and is then edited through Trivia. This is the acceptance test of the track so far, not a new
component. (BR-05, BR-07, BR-08, BR-09)

## The app

A small back office on one PostgreSQL schema, the same domain as `examples/refine-admin`:

- **Model:** `Customer` (name, email, status enum, credit limit, notes, created at),
  `Account` (belongs to a customer; number, type enum, balance, opened on).
- **Pages:** customers list with filters on status and email; customer create and edit forms;
  customer show; accounts list filtered by customer.
- **Two actions:** `approveKyc` on a customer (a custom operation, as a row action with a
  confirmation), and "Refresh" on the list (a header action that refetches).

The blueprint lives at `examples/blueprint-mvp/blueprint/`. The generated solution is not
committed: tests generate it into a temp folder.

## User Scenarios & Testing

### User Story 1 - From blueprint to running solution (Priority: P1)

**Independent Test**: `tools/blueprint/mvp.test.mjs` runs the commands below in a temp folder.

**Acceptance Scenarios**:

1. **Given** an empty folder and the MVP blueprint, **When** `trivia-blueprint new`,
   `trivia-blueprint backend --migration Initial` and `trivia-blueprint eject` run, **Then**
   `dotnet build -warnaserror` and `tsc` both pass.
2. **Given** that solution, **When** the AppHost starts, **Then** a customer can be created
   through the API and appears in the list endpoint.
3. **Given** the web app running against it, **When** the customers page loads in a browser,
   **Then** it lists customers, filters by status, opens the create form, saves a customer,
   and shows a field error returned by the API.
4. **Given** the row action Approve KYC, **When** it is confirmed, **Then** the API's custom
   operation is called. It answers 501 until implemented, and the page shows that as an error
   notification without breaking.

### User Story 2 - Then edit it with Trivia (Priority: P1)

**Acceptance Scenarios**:

1. **Given** the ejected customers list in the designer, **When** the columns tool adds
   `creditLimit`, **Then** only the new column's lines change in the file, and undo restores
   the bytes.
2. **Given** the ejected edit form, **When** the form-fields tool adds `notes`, **Then** rule,
   default and control are added as one undo entry.
3. **Given** a button on the show page, **When** its variant is changed in the inspector,
   **Then** one attribute changes.
4. **Given** any of these edits, **When** the page is ejected again from the blueprint,
   **Then** it is refused with `conflict`.

### User Story 3 - Change the model and follow the drift (Priority: P1)

**Acceptance Scenarios**:

1. **Given** the model gains `Customer.segment` (an enum) and loses `notes`, **When**
   `trivia-blueprint backend --migration Segment` runs, **Then** only `.g.cs` files and one
   migration change on the backend, and the drift list names the edit form's `notes` field
   with a fix.
2. **Given** the fix is applied and `segment` is added with the columns tool, **Then** `tsc`
   passes and the list shows the new column.

### User Story 4 - An agent builds it (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a fresh Claude Code session with only the Trivia MCP server and the prompt in
   `examples/blueprint-mvp/PROMPT.md`, **When** it finishes, **Then** the blueprint it wrote
   validates with no errors, ejects, and the web app type-checks. It did not read or edit
   generated code to get there.

### Edge Cases

- The machine has no container runtime: the test is skipped with a message, not failed.
- The registry is unreachable: the test uses the committed kit of `examples/blueprint-kit`.

## Requirements

**FR-MVP-01** to **FR-MVP-04** (`docs/blueprint/SRS.md` section 3.11). This slice also
exercises, end to end, FR-BP, FR-MF, FR-EX, FR-AG, FR-RC, FR-KT, FR-DM, FR-NC and FR-AS.

## Success Criteria

- **SC-001**: The scripted test of story 1 passes on a clean machine with Node, pnpm, the .NET
  SDK and a container runtime.
- **SC-002**: The Playwright spec of stories 1 to 3 passes.
- **SC-003**: The agent session of story 4 succeeds twice in a row from a fresh session.
- **SC-004**: A one-field model change is a blueprint diff under ten lines, and the backend
  diff touches only `.g.cs` files and one migration.
- **SC-005**: From the empty folder to the running app takes under ten minutes on the
  reference machine, most of it package restore.

## Assumptions and out of scope

- Auth is off (`auth.mode: "none"`).
- Custom pages are covered by the kit fixture, not here. This app uses contract pages.
- Publishing is not part of the slice.
