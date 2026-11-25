# Feature Specification: Expression compiler

**Feature Branch**: `003-expression-compiler`
**Created**: 2026-11-25
**Status**: Draft
**Phase**: 0
**Input**: Bindings are checked when a blueprint is saved, not when the app runs, and compile
one to one into the emitted TypeScript. (BR-03)

## User Scenarios & Testing

### User Story 1 - Know at once that a binding is wrong (Priority: P1)

An author writes a binding. If it uses unsupported syntax, an unknown name or an impure call,
the diagnostic says what and where.

**Independent Test**: A table of expressions with the expected code and span.

**Acceptance Scenarios**:

1. **Given** the binding `state.count = 1`, **When** analyzed, **Then**
   `expr_unsupported_syntax` covers the assignment.
2. **Given** `stat.count` where the scope has `state`, **When** analyzed, **Then**
   `expr_unknown_root` covers `stat`.
3. **Given** `fetch("/x")`, **When** analyzed, **Then** `expr_impure_call` covers the callee.
4. **Given** an expression containing an emoji before the error, **When** analyzed, **Then**
   the span is correct in UTF-16 units.

### User Story 2 - Know what a binding depends on and where it can run (Priority: P1)

The validator and the compilers learn each expression's dependencies and tier.

**Acceptance Scenarios**:

1. **Given** `` `${data.customers.total} of ${state.limit}` ``, **When** analyzed, **Then** its
   dependencies are `data.customers` and `state.limit`, and its tier is `client`.
2. **Given** a query whose parameters use only `params.id`, **When** an expression reads that
   query, **Then** its tier is `server`.
3. **Given** `"Customers"`, **When** analyzed, **Then** its tier is `static`.

### User Story 3 - Catch cycles (Priority: P2)

**Acceptance Scenarios**:

1. **Given** query A's parameters read query B and B's read A, **When** the page is analyzed,
   **Then** one `expr_cycle` is reported on both, with the path A, B, A.

### User Story 4 - Emit TypeScript without disturbing the text (Priority: P1)

The compiler renames scope roots to the identifiers it chose and gets valid TypeScript back.

**Acceptance Scenarios**:

1. **Given** `data.customers.total > 0 && state.selectedId !== null` and a rename map,
   **When** emitted, **Then** only the renamed member chains differ from the input.
2. **Given** an identity rename, **When** emitted, **Then** the output equals the input byte
   for byte, comments and spacing included.
3. **Given** a node renamed from `search` to `query`, **When** references are renamed,
   **Then** every `ui.search` in the stored sources becomes `ui.query`, and nothing else moves.

### Edge Cases

- An arrow parameter named like a root (`state => state.x`) shadows it, with a warning.
- An expression longer than the limit, or nested deeper than the limit.
- CRLF inside a template literal.
- An empty string, and a string of only whitespace.
- A batch where one expression fails to parse: the others are still answered.

## Requirements

Full text in `docs/blueprint/SRS.md` section 3.3: **FR-EX-01** to **FR-EX-08**, and **NFR-04**
(1 000 expressions in under 50 ms).

### Key Entities

- **Scope**: roots with their tier and known members, plus locals.
- **Analysis result**: ok, dependencies, tier, diagnostics with UTF-16 spans.
- **Rename map**: member paths to emitted identifiers, longest prefix wins.

## Success Criteria

- **SC-001**: Every form in LLD-03's accepted and refused tables has a test line.
- **SC-002**: Identity emission is byte-identical for every accepted test expression.
- **SC-003**: The fuzz target runs 10 million inputs without a panic.
- **SC-004**: The benchmark meets NFR-04 on the reference machine.
- **SC-005**: The napi crash suite covers the three new functions within its RSS bound.

## Assumptions and out of scope

- No type checking beyond known members. `tsc` checks emitted code (spec 005).
- No evaluation, ever.
