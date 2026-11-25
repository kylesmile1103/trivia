# Feature Specification: Blueprint agent surface

**Feature Branch**: `004-blueprint-agent-surface`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 0 (preview and eject tools complete in Phase 1, backend in Phase 2)
**Input**: Agents and the designer read and change blueprints over the dev server, with the
same guards, undo history and error model as engine edits. (BR-04)

## User Scenarios & Testing

### User Story 1 - An agent authors a blueprint (Priority: P1)

An agent with only the Trivia MCP server reads the blueprint, patches it, reads the
diagnostics in the result and patches again until none are left.

**Independent Test**: A scripted MCP client creates a two-page blueprint on a copy of
`examples/refine-admin`.

**Acceptance Scenarios**:

1. **Given** a project with no blueprint, **When** `trivia_blueprint_get` is called, **Then**
   the summary says `exists: false` and its `next` field suggests creating a page.
2. **Given** a patch that creates a page with an unknown resource, **When** it is applied,
   **Then** the page is written, and the result carries `unknown_resource` with the list of
   known resources.
3. **Given** a patch result with errors, **When** the agent sends fixing ops with the new
   revisions, **Then** the summary's error count reaches 0.
4. **Given** `what: "components"`, **When** read, **Then** the result lists each type with its
   props schema, slots, events, exposed values and whether it is installed.

### User Story 2 - Nobody overwrites anybody (Priority: P1)

A person in the designer and an agent work on the same blueprint.

**Acceptance Scenarios**:

1. **Given** two clients read revision R, **When** both patch, **Then** the first succeeds and
   the second gets 409 `conflict` with the current revisions, and its ops are not applied.
2. **Given** a file edited by hand after a read, **When** a patch arrives with the old
   revision, **Then** it is refused the same way.

### User Story 3 - Undo works across tools (Priority: P1)

**Acceptance Scenarios**:

1. **Given** an agent's patch labelled "Add orders page", **When** `trivia_undo` is called with
   that label, **Then** every touched document is restored byte for byte.
2. **Given** a patch followed by a hand edit of the same file, **When** undo is requested,
   **Then** it is refused with `conflict`, as for source files.

### User Story 4 - Preview and eject from an agent (Priority: P2, completed by spec 005)

**Acceptance Scenarios**:

1. **Given** a valid draft page, **When** `trivia_blueprint_preview` is called, **Then** the
   result has the preview route, and `trivia_screenshot` shows the page once the canvas has
   loaded it.
2. **Given** valid draft pages, **When** `trivia_blueprint_eject` is called, **Then** the files,
   resource entries and routes are written as one `Agent: <label>` undo entry.

### User Story 5 - Only this machine (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a client that is not on loopback, **When** it calls any blueprint route, **Then**
   it gets 403 `forbidden`, directly and through the designer's proxy.
2. **Given** a `path` that leaves the blueprint directory, **When** a document is requested,
   **Then** it is refused with `path_outside_root`.

### Edge Cases

- The blueprint directory does not exist yet: the first patch creates it.
- A document from a newer blueprint version.
- A patch whose ops span three documents, with the stale revision on the third.
- The designer is closed when a preview is requested.

## Requirements

Full text in `docs/blueprint/SRS.md` section 3.4: **FR-AG-01** to **FR-AG-07**, with
**NFR-05**, **NFR-12** and **NFR-14**.

### Key Entities

- **BlueprintSummary**, **PatchResult**, **PreviewResult**, **EjectPlan**, **BackendResult**
  (LLD-04 section 2).

## Success Criteria

- **SC-001**: A real Claude Code session with only this server builds a valid two-page
  blueprint from a short prompt, and what it tripped on is fixed and noted in `docs/mcp.md`.
- **SC-002**: Every route and tool has an entry and an example in `docs/api.md` and
  `docs/mcp.md`, pinned by a test.
- **SC-003**: Patch then undo restores bytes in the plugin test and in the e2e test.

## Assumptions and out of scope

- Compiling (preview, plan) is spec 005. This feature defines those routes and tools and
  returns `unsupported` for them until the compiler lands.
- The backend route is spec 009 and 010. Same treatment.
- No push channel. Clients re-read.
