# Feature Specification: Component kit

**Feature Branch**: `006-component-kit`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 1
**Input**: A blueprint author can use 25 shadcn components, a data table and a form by name,
and gets code that Trivia's day-2 tools can keep editing. (BR-02, BR-05)

## User Scenarios & Testing

### User Story 1 - Build a page from kit components (Priority: P1)

**Independent Test**: The kit fixture blueprint compiles, type-checks and renders.

**Acceptance Scenarios**:

1. **Given** a custom page using each of the 25 types, **When** compiled, **Then** every type
   prints with its parts (a `Card` with header and content, a `Dialog` with its trigger) and
   `tsc` passes.
2. **Given** each type that exposes a value, **When** a text is bound to it, **Then** the
   rendered text follows the control in the browser.
3. **Given** a project on shadcn's Base UI components, **When** the same page is compiled,
   **Then** the change props match that base.

### User Story 2 - A data table that stays editable (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a `DataTable` node with a resource and four columns, **When** compiled, **Then**
   the page has a Refine table with server-side paging, sorting and filtering, and columns
   written exactly as the columns tool writes them.
2. **Given** the ejected page, **When** the columns tool adds, reorders and removes a column,
   **Then** it works as on a hand-written list page.
3. **Given** `selectable: "single"`, **When** a binding reads `ui.customers.selectedRow.id`,
   **Then** it resolves and follows the selection.

### User Story 3 - A form that stays editable (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a `Form` node with four fields, **When** compiled, **Then** it has a zod rule, a
   default and a control per field, in the project's form style, with widgets by field type.
2. **Given** the ejected form, **When** the form-fields tool adds a contract field, **Then**
   rule, default and control are added as on a hand-written form.
3. **Given** the contract's `maxLength` changes, **When** drift is listed, **Then** the form's
   rule is reported and fixed in place.

### User Story 4 - Clear limits (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a node of type `Tree`, **When** validated, **Then** `unknown_component` says it is
   deferred and suggests a local component with a manifest.

### User Story 5 - Large client-side tables (Priority: P3)

**Acceptance Scenarios**:

1. **Given** a table with `pagination: "off"` and `virtual: true`, **When** it renders 5 000
   rows, **Then** only the visible rows are in the DOM.

### Edge Cases

- A kit type installed under a different file name than the registry default.
- A `Form` in a project that has both `ui/field.tsx` and `ui/form.tsx`.
- A `DataTable` for a resource without a list operation.
- `virtual: true` with server paging (ignored, with a warning).

## Requirements

Full text in `docs/blueprint/SRS.md` section 3.6: **FR-KT-01** to **FR-KT-07**, with **NFR-13**.

### Key Entities

- **Kit manifest** per type, with base variants. **Composite** expansions `DataTable` and
  `Form`. The **deferred list**. The **kit fixture** blueprint and its app.

## Success Criteria

- **SC-001**: A test fails when a kit type has no page in the fixture.
- **SC-002**: The fixture's compiled pages pass `tsc` for Radix and for Base UI variants.
- **SC-003**: The e2e run loads every fixture route with no console error.
- **SC-004**: The columns and form-fields tools pass their existing plugin tests against
  pages emitted by the composites.

## Assumptions and out of scope

- No component source is shipped. The user installs from the shadcn and Refine registries.
- Fixed columns, column resize, tree rows and editable cells are deferred.
