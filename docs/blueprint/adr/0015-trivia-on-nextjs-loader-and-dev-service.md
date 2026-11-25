# ADR-0015: Trivia on Next.js: a stamping loader and a dev service

- Status: Proposed ⚑ (the agent's call, for Kyle's review; the loader needs a spike)
- Date: 2026-11-25
- Requirements: BR-11, FR-TN-01 to FR-TN-07

## Context

Trivia's editor depends on Vite in two places. The plugin's `transform` hook stamps locators
before JSX is compiled away, and the plugin's dev-server middleware serves the engine API and
the MCP endpoint. Next.js 16 bundles with Turbopack by default and has no Vite plugin API.
`HANDOFF.md` lists Next.js among the likely next needs.

## Decision

1. **Extract a dev service.** `EngineService`, the HTTP routes, the guard and the MCP server
   move out of the Vite plugin into `@trivia/dev-service`, which can run as middleware (Vite)
   or as a small local HTTP server (Next.js). The Vite plugin becomes a thin host of it.
2. **Stamp with a loader.** `@trivia/next` provides a webpack-style loader that calls the same
   `annotate` function. It is registered for `next dev` only, through `turbopack.rules` and
   through the webpack config, on `.tsx` and `.jsx` files outside `node_modules`.
3. **Route in the designer's proxy.** `/@trivia/api` and `/@trivia/mcp` go to the dev service,
   everything else to the Next.js dev server, so the canvas stays same-origin (rule 7).

The loader is the unproven part. The feature's first task is a spike that shows a Turbopack
loader sees TSX before the compiler does and that its source map survives. Fallbacks, in
order: a Babel-based loader, then an SWC plugin built from the same Rust crate.

## Consequences

- One locator algorithm still serves every host (rule 3).
- The Vite plugin is refactored without a change in behaviour. Its test suite is the proof.
- Server components are stamped like any other JSX. Elements rendered on the server carry
  their locators into the DOM.
- A second process runs beside `next dev`. The launcher in `@trivia/next` starts both.

## Alternatives

- **Next.js route handlers as the API host.** Puts Trivia code inside the user's app tree.
- **Support Next.js through webpack only.** Leaves out the default bundler.
