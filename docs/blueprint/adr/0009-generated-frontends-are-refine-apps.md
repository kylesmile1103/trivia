# ADR-0009: Generated frontends are Refine + shadcn apps

- Status: Proposed ⚑ (the agent's call, for Kyle's review)
- Date: 2026-11-25
- Requirements: FR-RC-02, FR-RC-03, FR-KT-02 to FR-KT-04, FR-AS-06

## Context

The research suggested emitting plain React with hey-api TanStack Query hooks. Trivia's product
decision, though, is that it is the day-2 tool for Refine + shadcn apps: the columns, form
fields, drift and new-resource tools all read Refine pages, and `docs/product.md` says that in a
Refine app data goes through Refine's hooks, never raw TanStack hooks. An emitted app those
tools cannot read would be a second product.

## Decision

Both targets emit a Refine app: `@refinedev/core` with the router binding for the target,
refine-ui components from Refine's shadcn registry, and the user's own shadcn components.

- Contract pages (`list`, `create`, `edit`, `show`) are produced by the existing generator in
  the plugin's Refine adapter, with the blueprint's options.
- Custom pages use Refine hooks for data (`useList`, `useOne`, `useCustom`, the mutation hooks).
- The app gets a generated data provider for the generated API's conventions.

Components are never vendored by the compiler. They come from the shadcn registry into the
user's project, so the user owns them and Trivia's inspector reads them as it does today.

## Consequences

- Day 1 and day 2 meet with no adapter: an ejected app is exactly what Trivia already edits.
- The Refine generator becomes shared code with two callers, and its limits (six list columns,
  no nested body fields) become the blueprint's until they are lifted for both.
- Emitted apps depend on Refine. Teams that do not want it are not served yet.
- "Generating a Refine data provider is day 1, so it is out" (`docs/product.md`) is superseded:
  day 1 is now in, and we control the API it talks to.

## Alternatives

- **Plain TanStack Query.** Fewer dependencies in emitted apps, but it needs its own page
  generator and leaves the day-2 tools without their footing.
- **A pluggable data layer from the start.** More surface than one developer should carry
  before the first user.
