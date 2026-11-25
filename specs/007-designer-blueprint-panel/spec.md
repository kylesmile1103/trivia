# Feature Specification: Designer Blueprint panel

**Feature Branch**: `007-designer-blueprint-panel`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 1 (stories 1 to 4), 2 (stories 5 and 6)
**Input**: A developer creates, previews and ejects blueprint pages, and edits the data model,
from the designer, on the same history as every other edit. (BR-04, BR-06)

## User Scenarios & Testing

### User Story 1 - See and create pages (Priority: P1)

**Independent Test**: A Playwright run on the refine example with an empty blueprint.

**Acceptance Scenarios**:

1. **Given** a project without a blueprint, **When** the Blueprint tab opens, **Then** it
   offers to create one, with the detected target.
2. **Given** a blueprint, **When** the tab opens, **Then** each page shows its name, route,
   kind, status and error count.
3. **Given** the page form with kind `list` and a contract resource, **When** saved, **Then**
   a draft page exists and the change is one entry in the history.
4. **Given** no contract in the project, **When** a page is created, **Then** contract kinds
   are disabled with a pointer to the Data tab's sync.

### User Story 2 - Preview and eject (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a valid draft, **When** Preview is pressed, **Then** the canvas shows the page
   with a banner saying it is a draft preview.
2. **Given** a valid draft, **When** Eject is confirmed, **Then** the dialog had listed the
   files and route changes, the page is written, the canvas moves to the real route, and its
   elements are selectable.
3. **Given** a missing component, **When** Eject is pressed, **Then** the dialog shows the
   command that adds it and no confirm button.
4. **Given** an ejected page, **When** the toolbar's undo is pressed, **Then** the files, the
   routes and the lock are back to what they were.

### User Story 3 - Build a custom page (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a custom page, **When** a `Card` and an `Input` are added from the component
   list, **Then** the tree shows them and the file changes by those nodes only.
2. **Given** a node, **When** a prop is switched to a binding with an error, **Then** the
   expression input underlines the span and shows the message.
3. **Given** two nodes, **When** one is dragged before, after or inside the other, **Then**
   the tree follows the same drop rules as the Layers tab.

### User Story 4 - Stay in step with other writers (Priority: P1)

**Acceptance Scenarios**:

1. **Given** an agent patches the blueprint while the panel is open, **When** the user then
   saves a change, **Then** the panel says the change was not applied, reloads, and shows the
   agent's version.
2. **Given** an ejected page whose file was edited, **When** the list reloads, **Then** its
   status reads `edited`, with the note that the code is now the truth.

### User Story 5 - Edit the data model (Priority: P1 in Phase 2)

**Acceptance Scenarios**:

1. **Given** the model editor, **When** an entity with five fields is entered, **Then** each
   cell edit is one model op, and reserved names are flagged inline.
2. **Given** a `hasMany` relation without its `belongsTo`, **When** shown, **Then** the
   diagnostic offers the fix as a button.

### User Story 6 - Generate the backend (Priority: P1 in Phase 2)

**Acceptance Scenarios**:

1. **Given** a valid model, **When** Generate backend is pressed, **Then** a table lists each
   file with create, update, unchanged or refused, before anything is written.
2. **Given** the plan is confirmed, **When** it finishes, **Then** the dialog shows the next
   steps (build, sync, drift) and says backend writes are outside undo.

### User Story 7 - Select from a preview (Priority: P3)

**Acceptance Scenarios**:

1. **Given** a preview, **When** an element is clicked, **Then** its blueprint node is
   selected in the tree.

### Edge Cases

- A fifth tab in a 272 px column.
- A very long route or page name.
- The dev server restarts while the panel is open.
- `dotnet` is not installed when Generate backend is pressed.

## Requirements

Full text in `docs/blueprint/SRS.md` section 3.7: **FR-DS-01** to **FR-DS-09**.

### Key Entities

- The feature's state: the summary, the open document with its revision, the pending patch.

## Success Criteria

- **SC-001**: `architecture.test.ts` passes with the new feature and the moved shared code.
- **SC-002**: Create, preview, eject and undo pass in e2e on the refine example.
- **SC-003**: A conflict never loses data and never retries by itself.
- **SC-004**: Every action of the panel has a keyboard path, and controls have labels.

## Assumptions and out of scope

- Draft pages are edited in the tree, not on the canvas. After eject the canvas is the editor.
- No push channel from the plugin. The panel re-reads on focus and after history changes.
