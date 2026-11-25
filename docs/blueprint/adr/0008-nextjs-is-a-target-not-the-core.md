# ADR-0008: The editor stays on Vite; Next.js is a target and a supported host

- Status: Accepted
- Date: 2026-11-25
- Requirements: BR-10, BR-11, FR-NX-01 to FR-NX-08

## Context

The original request was to move the builder itself to Next.js. An editor is client state:
canvas, drag and drop, inspector, undo. Server rendering gives it nothing. Server rendering
does help published pages whose content is static or known at request time. Next.js was at
16.x in November 2026, with Cache Components due to become the default in 17, so its APIs are
still moving.

## Decision

- The designer stays a Vite single-page app.
- Next.js App Router is a code generation **target**, added in Phase 3 behind the compiler's
  target interface. The first target is Vite.
- Trivia's editor also learns to work **on** Next.js apps (ADR-0015).
- No package of the platform core depends on Next.js.

## Consequences

- Phases 0 to 2 are not exposed to Next.js churn.
- Server rendering arrives where it pays: the static and request-time tiers of a page (LLD-12).
  For an expression-heavy internal tool the gain is first paint, and the docs should say so.
- A second target doubles the emitter's test matrix. The IR and everything before it stay
  shared (FR-NX-07).

## Alternatives

- **Next.js everywhere.** No benefit for the editor, and a Node tier for every user.
- **TanStack Start or React Router framework mode as the second target.** Both fit the target
  interface. Next.js goes first because it was the request.
