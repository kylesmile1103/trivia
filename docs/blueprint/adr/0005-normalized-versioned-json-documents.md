# ADR-0005: Blueprints are normalized, versioned JSON documents in git

- Status: Accepted
- Date: 2026-11-25
- Requirements: BR-01, FR-BP-01 to FR-BP-08, NFR-02, NFR-11

## Context

Nested component trees stored as one JSON blob make poor diffs: moving a node rewrites its
subtree, and two people editing siblings conflict. Retool built a separate format for source
control for that reason. Webstudio's model (flat maps of instances, props, styles and data
sources) is the best public reference for the alternative.

## Decision

- A blueprint is several files: one app document, one model document, one document per page.
- A page is flat maps keyed by stable ids: `nodes`, `props`, `bindings`, `styles`, `control`,
  `state`, `queries`, `actions`. A node points at its parent and carries a fractional index for
  its order.
- Ids are generated (a prefix and a ULID). Human-readable names sit beside them and are what
  expressions use.
- Every document carries `$schema` and `blueprintVersion`. Migrations are forward only and run
  on load.
- Serialization is canonical, so equal documents are equal bytes.
- Files live in the repository, inside the web app's root.

## Consequences

- Changes are local: one node moved is one line changed.
- JSON Patch, three-way merge and CRDTs all work on this shape, which keeps a hosted store
  possible (HLD section 11).
- Flat maps are harder to read than a tree. A JSX-like projection covers reading (FR-BP-10).
- ⚑ The projection is read-only in version 1. Agents write through ops, not by editing the
  projection, so there is no second parser to keep in step.

## Alternatives

- **A JSX-like file as the stored format.** Reads well, but Retool's own experience was that
  models do better on real React than on a look-alike, and it would need a parser of its own.
- **One file for the whole app.** Simpler loading, worse diffs and merges.
