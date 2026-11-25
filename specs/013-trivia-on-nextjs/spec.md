# Feature Specification: Trivia on Next.js

**Feature Branch**: `013-trivia-on-nextjs`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 3
**Input**: A developer points the Trivia designer at a Next.js App Router app and edits it as
they edit a Vite app today. (BR-11)

## User Scenarios & Testing

### User Story 1 - Know that it can work (Priority: P1)

Before any refactor, a spike answers the six questions of LLD-13 section 1.

**Acceptance Scenarios**:

1. **Given** a throwaway App Router app on the pinned Next.js with Turbopack, **When** the
   stamping loader is registered, **Then** elements of client and server components carry
   `data-ast-node` in the DOM, and stack traces still point at the user's lines.
2. **Given** a question that fails with Turbopack, **Then** the fallback is tried, and the
   choice is recorded as an ADR that supersedes ADR-0015.

### User Story 2 - Nothing changes for Vite users (Priority: P1)

**Acceptance Scenarios**:

1. **Given** the engine API and MCP moved into a dev service, **When** the plugin's and the
   e2e suites run, **Then** every test passes without a change to its assertions.
2. **Given** `git log --follow` on a moved file, **Then** its history is intact.

### User Story 3 - Select and edit on Next.js (Priority: P1)

**Independent Test**: A Playwright project on `examples/next-admin`.

**Acceptance Scenarios**:

1. **Given** `trivia-next dev` and the designer, **When** an element is clicked on the canvas,
   **Then** it is selected and the inspector shows its props.
2. **Given** a selected button in a client component, **When** its variant changes, **Then**
   one attribute changes in the file, the canvas refreshes, and the selection is still on it.
3. **Given** a heading in a server component, **When** its text is edited, **Then** the file
   changes by that text only, the canvas shows it, and undo restores the bytes.
4. **Given** insert, move and remove, **Then** each works as on Vite, with the same guards.

### User Story 4 - Pages and Refine tools (Priority: P2)

**Acceptance Scenarios**:

1. **Given** an app with route groups, dynamic segments and a catch-all, **When** the Pages
   tab opens, **Then** it lists each route with its URL pattern and file.
2. **Given** a Refine list page in the example, **When** the columns tool adds a column,
   **Then** it works as on Vite.

### User Story 5 - Agents on Next.js (Priority: P2)

**Acceptance Scenarios**:

1. **Given** `trivia-next dev`, **When** an MCP client connects to the printed URL, **Then**
   the same tools answer as on Vite.

### User Story 6 - Never in production (Priority: P1)

**Acceptance Scenarios**:

1. **Given** `next build` of the example, **Then** its output has no `data-ast-node`, and no
   Trivia code is in the bundle.
2. **Given** the dev service, **When** a client that is not on loopback calls it, **Then** it
   gets 403 `forbidden`.

### Edge Cases

- An app that only has the `pages/` router.
- The webpack bundler instead of Turbopack.
- The React Compiler turned on.
- Windows path separators in the loader.
- Port clashes between `next dev`, the dev service and the designer.

## Requirements

Full text in `docs/blueprint/SRS.md` section 3.13: **FR-TN-01** to **FR-TN-07**, with
`CLAUDE.md` rules 3, 5, 6 and 7.

### Key Entities

- **DevHost**: what a host gives the dev service. **Dev service**: the engine API and MCP
  without Vite. **Stamping loader**. **Launcher** (`trivia-next dev`).

## Success Criteria

- **SC-001**: The spike's six answers are written down in LLD-13.
- **SC-002**: The Vite plugin's suite and the existing e2e projects pass unchanged after the
  extraction.
- **SC-003**: The loader passes the engine's locator fixtures.
- **SC-004**: The Next.js Playwright project passes its subset, including one server component
  edit.
- **SC-005**: A production build of the example contains no locator attribute.

## Assumptions and out of scope

- App Router only. The `pages/` router is not supported.
- Independent of spec 012: the app may be hand-written.
