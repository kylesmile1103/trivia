# Feature Specification: Component manifests

**Feature Branch**: `002-component-manifests`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 0
**Input**: Blueprint nodes are instances of the user's own shadcn components. Each needs a
typed description that a validator, a compiler and an agent can rely on. (BR-02)

## User Scenarios & Testing

### User Story 1 - Validate a node against the user's real component (Priority: P1)

A node of type `Button` is checked against the `Button` in the user's `src/components/ui`, so
a variant the user added is accepted and one they removed is refused.

**Independent Test**: Resolve manifests against `examples/refine-admin` and validate fixture
pages.

**Acceptance Scenarios**:

1. **Given** the user's `button.tsx` defines a variant `brand`, **When** a node sets
   `variant: "brand"`, **Then** it is valid, though the kit's manifest does not list it.
2. **Given** a node sets a prop the component does not have, **When** validated, **Then**
   `unknown_prop` points at that prop.
3. **Given** a child node placed in a slot its parent does not have, **When** validated,
   **Then** a diagnostic names the parent's slots.

### User Story 2 - Learn what is missing (Priority: P1)

A blueprint uses a kit component that the project has not installed.

**Acceptance Scenarios**:

1. **Given** `ui/select.tsx` is absent, **When** a page uses `Select`, **Then** validation
   reports `missing_component` with the registry item and the command that adds it, and
   nothing is installed.

### User Story 3 - Use events and exposed values (Priority: P1)

An author binds a text to an input's value and attaches an action to a button's click, using
names the manifest declares.

**Acceptance Scenarios**:

1. **Given** `Input` exposes `value`, **When** an expression reads `ui.search.value`, **Then**
   the reference resolves, with the type the manifest gives.
2. **Given** an action keyed on an event the type does not declare, **When** validated,
   **Then** `unknown_event` lists the events it has.
3. **Given** a binding on the change prop of an exposed value, **When** validated, **Then** it
   is refused with a hint to use an action on the event instead.

### User Story 4 - Use components the kit does not know (Priority: P2)

A project has its own components, and wants HTML elements too.

**Acceptance Scenarios**:

1. **Given** a local component `StatCard` in the user's library, **When** a node uses it,
   **Then** it gets a derived manifest: its analyzed props, and a `children` slot if it
   accepts children.
2. **Given** a file `blueprint/manifests/StatCard.manifest.json`, **When** manifests are
   resolved, **Then** the override's slots and events are used.
3. **Given** a node of type `div`, **When** validated, **Then** it is accepted with the
   curated HTML props.

### User Story 5 - Give agents a schema (Priority: P3)

**Acceptance Scenarios**:

1. **Given** resolved manifests, **When** their JSON Schema is requested, **Then** each type
   has a props schema and an index entry with slots, events, exposed values and `installed`.

### Edge Cases

- The project's shadcn base is Base UI, so a change prop has another name than under Radix.
- An override annotates a prop that the user's component no longer has.
- Two components export the same name from different files.
- `components.json` is missing or has no `ui` alias.

## Requirements

Full text in `docs/blueprint/SRS.md` section 3.2: **FR-MF-01** to **FR-MF-07**.

### Key Entities

- **ComponentManifest**: type, source (registry, item, import, parts), props, slots, events,
  exposes, client, template, composite.
- **Resolved manifest set**: kit, overrides and the analyzer's schemas merged for one project,
  each entry flagged `installed`.

## Success Criteria

- **SC-001**: Against `examples/refine-admin`, every installed kit type resolves with props
  equal to the analyzer's output for that file.
- **SC-002**: Each manifest diagnostic code has a fixture.
- **SC-003**: Resolution is a pure function: the same four inputs give the same result, with
  no file or network access.

## Assumptions and out of scope

- The kit's manifest files themselves are spec 006. This feature ships the types, the
  resolver, the checks and three sample manifests (`Button`, `Input`, `Card`) to test with.
- Prop analysis is the engine's existing analyzer, unchanged.
