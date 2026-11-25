# Feature Specification: React code generation (Vite target)

**Feature Branch**: `005-react-codegen-vite`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 1
**Input**: A valid blueprint page becomes idiomatic React + shadcn + Refine code that the user
previews, ejects into their project and then owns. (BR-05, BR-06, BR-07)

## User Scenarios & Testing

### User Story 1 - Eject contract pages (Priority: P1)

A blueprint has `list`, `create`, `edit` and `show` pages for a contract resource. Ejecting
them writes the pages, the resource entry and the routes.

**Why this priority**: It is the shortest path from a blueprint to a working CRUD screen, and
it reuses a generator that already exists.

**Independent Test**: On a copy of `examples/refine-admin`, eject four pages for a resource
that has none, then run `tsc`.

**Acceptance Scenarios**:

1. **Given** a `list` page for `Account` with default options, **When** it is compiled,
   **Then** its bytes equal what `refine/pages/plan` produces for the same resource.
2. **Given** four draft pages, **When** they are ejected, **Then** four files, one resource
   entry and four routes are written as one undo entry, and undo removes all of it.
3. **Given** options `fields`, `filters` and a row action, **When** compiled, **Then** the
   list shows those columns and filters, and the action's button runs its steps.

### User Story 2 - Compile a custom page (Priority: P1)

A custom page with nodes, state, a query, bindings and actions compiles to one readable
component.

**Independent Test**: Golden files for the fixture pages, then the engine's parser and `tsc`.

**Acceptance Scenarios**:

1. **Given** an `Input` named `search` and a text bound to `ui.search.value`, **When**
   compiled, **Then** the component holds one `useState`, wires the input's value and change
   props to it, and renders the text from it.
2. **Given** a `list` query with a parameter bound to state, **When** compiled, **Then** the
   Refine list hook receives that parameter, and `data.<q>.items` reads the hook's rows.
3. **Given** a button with steps `mutate`, `refetch`, `toast`, **When** compiled, **Then** one
   async handler runs them in order.
4. **Given** a node with `when` and another with `each`, **When** compiled, **Then** the JSX
   uses a conditional and a keyed `map`.
5. **Given** the same blueprint compiled twice, **Then** the bytes are identical.

### User Story 3 - Preview is the real thing (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a valid draft page, **When** it is previewed, **Then** the canvas renders it
   inside the app, against the app's data provider, with the app's theme.
2. **Given** a previewed page, **When** it is ejected, **Then** the file's bytes equal the
   previewed module's code.
3. **Given** the draft changes, **When** the preview reloads, **Then** it shows the new code.

### User Story 4 - Eject never destroys work (Priority: P1)

**Acceptance Scenarios**:

1. **Given** an ejected page whose file is untouched, **When** the draft changes and it is
   ejected again, **Then** the file is replaced.
2. **Given** an ejected page whose file was edited by one byte, **When** it is ejected again,
   **Then** the request is refused with 409 `conflict`, and nothing is written.
3. **Given** a page that needs `Select` in a project without it, **When** a plan is requested,
   **Then** it is refused with 422 and the registry item to add.
4. **Given** a route that already exists and is not in the lock, **When** a plan is requested,
   **Then** it is refused with 409.

### User Story 5 - Work without a dev server (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a project with a blueprint, **When** `trivia-blueprint validate` runs, **Then** it
   prints the diagnostics and exits 1 on errors.
2. **Given** an empty folder, **When** `trivia-blueprint new backoffice` runs, **Then** a Vite
   Refine app with an empty blueprint exists, and the command prints how to add the kit.

### Edge Cases

- A page whose name clashes with an existing component file.
- Two nodes whose derived identifiers collide.
- A `call` step whose handler file exists, and one whose file does not.
- A project that uses single quotes and no semicolons.
- An app without `<Refine resources>` or without a catch-all route.

## Requirements

Full text in `docs/blueprint/SRS.md` section 3.5: **FR-RC-01** to **FR-RC-12**, with **NFR-01**,
**NFR-02**, **NFR-03** and **NFR-10**.

### Key Entities

- **PageIR**, **EmittedModule**, **EjectPlan**, **Lock**, the engine op **replaceFile**
  (LLD-05).

## Success Criteria

- **SC-001**: Every golden page parses without diagnostics and passes `tsc` in the fixture app.
- **SC-002**: Twenty compiles of the fixture in shuffled document order give one hash.
- **SC-003**: Eject, undo and redo are byte-exact in the plugin test and in the e2e test.
- **SC-004**: After eject, an element of a custom page is selected on the canvas and edited
  with the inspector, like any hand-written element.
- **SC-005**: No emitted file imports from `@trivia/*`.

## Assumptions and out of scope

- The target is a Refine + shadcn app on Vite with React Router (⚑ ADR-0009).
- The kit's manifests and composites are spec 006. This feature uses the three sample
  manifests and the intrinsic elements.
- No formatter is run. No Next.js here (spec 012).
