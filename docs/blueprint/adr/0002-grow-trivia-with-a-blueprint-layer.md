# ADR-0002: Grow Trivia with a blueprint layer (strategy C)

- Status: Accepted
- Date: 2026-11-25
- Requirements: BR-01, BR-05, BR-07, BR-13

## Context

The research compared three strategies: (A) a literal port, (B) a clean-room platform with
Openblocks' breadth, (C) a blueprint layer on Trivia that compiles to code. B was estimated at
28 to 43 person-months and competes head-on with Retool and with AI app builders. C reuses the
engine, the designer, the inspector and contract-sync, and was estimated at 6 to 9 months to an
MVP. Both figures are inference.

`docs/product.md` says "Day 1 (scaffolding a new app) is out of scope. It may join a larger
ecosystem later."

## Decision

Take strategy C. A blueprint is an authoring and scaffolding format. It compiles to code, and
from then on Trivia's existing tools are the editor. The work lives in the Trivia repository
as new packages and one new crate (HLD section 3).

This record supersedes the day-1 exclusion of `docs/product.md` for the blueprint track only.
The target user stays the developer. The freeze on general editor features is not lifted by
this record.

## Consequences

- The positioning becomes: describe an internal tool, get a real React and ASP.NET Core
  codebase, keep editing it visually.
- Builders who are not developers will find it too close to code. That is accepted (BRD, P4).
- Day-1 work now competes with proving the day-2 tools on a real codebase. The order is the
  owner's call (BRD section 10).

## Alternatives

- **B, a new platform.** Kept as Phase 4, behind a demand gate (ADR-0014).
- **Stay day 2 only.** Leaves the differentiator the research found (real eject to a .NET and
  React stack) unbuilt.
