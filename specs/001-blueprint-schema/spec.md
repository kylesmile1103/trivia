# Feature Specification: Blueprint schema and store

**Feature Branch**: `001-blueprint-schema`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 0
**Input**: A typed, versioned, diff-friendly description of an app's pages, kept in git, that
people and agents change through guarded operations. (BR-01, BR-15)

## User Scenarios & Testing

### User Story 1 - Describe a page as a document (Priority: P1)

A developer or an agent describes a page (its route, kind, resource, and for custom pages its
nodes, state, queries and actions) as a JSON document under `blueprint/pages/`.

**Why this priority**: Everything else in the track reads this format.

**Independent Test**: Load the fixture blueprint, save it, and compare bytes.

**Acceptance Scenarios**:

1. **Given** a canonical blueprint on disk, **When** it is loaded and saved without changes,
   **Then** every file is byte-identical.
2. **Given** a document with its keys in another order, **When** it is saved, **Then** the
   bytes equal the canonical form of the same content.
3. **Given** a page of kind `list` with only a resource and options, **When** it is validated,
   **Then** it is valid with an empty node map.

### User Story 2 - Change a blueprint through guarded operations (Priority: P1)

An author sends a batch of BlueprintOps. Either all of them apply and the result is valid, or
nothing changes.

**Why this priority**: It is the only write path, for the designer and for agents.

**Independent Test**: Apply each op to a fixture and compare the diff with the expected lines.

**Acceptance Scenarios**:

1. **Given** a page at revision R, **When** an `addNode` op with `baseRev: R` is applied,
   **Then** the node appears with a generated id and an order key between its neighbours, and
   only its own entries change in the file.
2. **Given** a page at revision R2, **When** an op carries `baseRev: R`, **Then** it is refused
   with `conflict` and the current revisions, and no file changes.
3. **Given** a batch of three ops where the third is invalid, **When** it is applied, **Then**
   none of the three is written.
4. **Given** a node with a subtree, **When** `removeNode` is applied, **Then** the subtree's
   entries are gone from every map.

### User Story 3 - Get precise diagnostics (Priority: P1)

An author with an invalid or incomplete blueprint learns exactly what is wrong and where.

**Independent Test**: One fixture per diagnostic code, asserting the code and the JSON pointer.

**Acceptance Scenarios**:

1. **Given** a node whose parent does not exist, **When** the blueprint is validated, **Then**
   one `dangling_reference` points at that node's `parent`.
2. **Given** a prop present in both `props` and `bindings`, **When** validated, **Then** a
   diagnostic names the prop, and its hint contains the op that removes one of the two.
3. **Given** malformed JSON in one page file, **When** the blueprint is read, **Then** the
   other documents still load and the broken one is reported, without an exception.

### User Story 4 - Survive format changes (Priority: P2)

A blueprint written by an older version loads in a newer one.

**Acceptance Scenarios**:

1. **Given** a document at an older `blueprintVersion`, **When** it is loaded, **Then** it is
   migrated in memory and saved at the current version on the next write.
2. **Given** a document at a newer version, **When** it is loaded, **Then** it is refused with
   `unsupported_version` and never written.

### User Story 5 - Read a page as pseudo-code (Priority: P3)

A reviewer or an agent reads a page as a JSX-like projection.

**Acceptance Scenarios**:

1. **Given** a custom page, **When** its projection is requested, **Then** nodes print as
   nested elements named by type, with bindings in braces and logic in a trailing comment.

### Edge Cases

- A thousand inserts at the same position keep distinct, ordered keys.
- A rename of a node updates `ui.<name>` references in the page's expressions.
- A hand edit of a file between a read and a patch is detected through the revision.
- Two pages with the same route, or two nodes with the same name in a page.
- An empty blueprint directory, and a directory with pages but no app document.

## Requirements

Full text in `docs/blueprint/SRS.md` section 3.1.

- **FR-BP-01**: Documents, `$schema`, `blueprintVersion`.
- **FR-BP-02**: Flat maps keyed by id.
- **FR-BP-03**: Generated ids, unique identifier-safe names.
- **FR-BP-04**: Canonical serialization.
- **FR-BP-05**: Layered validation with stable codes and pointers, never throwing.
- **FR-BP-06**: Forward-only migrations, newer versions refused.
- **FR-BP-07**: BlueprintOps, atomic batches, `baseRev` and `expectedType` guards.
- **FR-BP-08**: Fractional index ordering.
- **FR-BP-09**: Page kinds.
- **FR-BP-10**: Read-only projection (should).
- **NFR-02, NFR-11, NFR-12**: Determinism, diff locality, atomicity.

### Key Entities

- **App document**: name, targets, auth mode, theme tokens, navigation.
- **Page document**: meta, and the maps `nodes`, `props`, `bindings`, `styles`, `control`,
  `state`, `queries`, `actions`.
- **BlueprintOp**: one guarded change. **Diagnostic**: code, severity, document, pointer,
  message, hint. **Revision**: the hash of a document's canonical bytes.

## Success Criteria

- **SC-001**: Every fixture round-trips to identical bytes.
- **SC-002**: A single-node change is a diff of at most six lines in one file.
- **SC-003**: Every diagnostic code has a fixture, and every op has a refusal test.
- **SC-004**: A 200-page blueprint loads and validates (layers 1 and 2) in under 1 second.
- **SC-005**: The published JSON Schemas validate every fixture under ajv strict mode.

## Assumptions and out of scope

- The model document's content is spec 008. Manifests are spec 002. Expressions are spec 003:
  this feature takes their checks through an injected context.
- The store computes writes. Performing them and recording history is spec 004.
- No editing through the projection.
