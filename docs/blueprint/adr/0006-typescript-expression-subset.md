# ADR-0006: Bindings are a TypeScript expression subset, analyzed with OXC

- Status: Accepted
- Date: 2026-11-25
- Requirements: BR-03, FR-EX-01 to FR-EX-08

## Context

Openblocks-style builders evaluate `{{ }}` JavaScript in a browser sandbox and discover
dependencies at run time. That makes errors late and re-evaluation broad. The candidates for a
checked language were a TypeScript subset, Power Fx and CEL.

## Decision

A binding is a TypeScript expression from a documented subset (LLD-03). There is no `{{ }}`
template syntax: a string with holes is a template literal.

- Expressions are parsed with OXC in a new crate, `trivia_expr`, at the engine's pinned version.
- Free identifiers must be scope roots. Dependencies, tiers and cycles are computed when the
  blueprint is validated.
- Emission renames roots by span splice and leaves the rest of the text alone. `tsc` then
  type-checks the result inside the emitted module.

## Consequences

- An expression compiles one to one into TSX, which no other candidate offers.
- Type errors inside an expression surface from `tsc` on the compiled page, not from our own
  checker. We check shapes we know (params, state, contract fields) and leave the rest to it.
- The subset must be defended. Each widening is a decision, because everything in it has to
  compile for every target.
- ⚑ Dependencies are computed on load and cached in memory, not stored in the document. The
  research suggested storing them. Stored derived data goes stale after a hand edit of the
  JSON, and recomputing is cheap (NFR-04).

## Alternatives

- **Power Fx or CEL.** Statically typed and usable from C#, but they need a translator to
  TypeScript and a second mental model.
- **Unrestricted JavaScript.** Cannot be analyzed, cannot be placed on the server safely.
