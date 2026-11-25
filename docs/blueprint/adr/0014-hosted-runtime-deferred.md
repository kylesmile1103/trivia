# ADR-0014: The hosted runtime and its dependencies are deferred

- Status: Accepted
- Date: 2026-11-25
- Requirements: BR-13

## Context

A hosted, multi-tenant builder with an interpreter, organisations, RBAC and dozens of
connectors is most of what the research priced at 28 to 43 person-months, and it is where the
competition is strongest. Only builders who are not developers need it.

## Decision

Phase 4 is not built until users ask for it. Until then these stay out:

- a hosted control plane and runtime;
- an interpreter of blueprints (also ruled out by ADR-0004);
- data source connectors beyond REST/OpenAPI and SQL through the generated API;
- server-side evaluation of user JavaScript;
- a plugin marketplace;
- MongoDB;
- round trip from arbitrary code back to a blueprint.

The gate: at least three teams using the MVP ask for non-developer authoring or hosting, and
the owner decides to take it on.

## Consequences

- The MVP stays within reach of one developer.
- Earlier phases must not block Phase 4. HLD section 11 lists what keeps it possible: plain
  documents with stable ids, a pure compiler, storage behind the store interface.

## Alternatives

- **Build the control plane first.** It is the familiar shape of a low-code product, and the
  surest way to never ship the differentiator.
