# Implementation Plan: Trivia on Next.js

**Branch**: `013-trivia-on-nextjs` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: [LLD-13](../../docs/blueprint/lld/LLD-13-trivia-on-nextjs.md) · ⚑ ADR-0015

## Summary

A spike, then two moves: extract a framework-neutral dev service from the Vite plugin, and add
`@trivia/next` with a stamping loader, a config wrapper and a launcher. The designer's proxy
learns a second target for Trivia's own paths.

## Technical Context

- **Language**: TypeScript. No Rust changes expected: the loader calls the existing `annotate`.
- **Dependencies**: Next.js in the example app only. `@trivia/next` has it as a peer.
- **Testing**: the plugin's suites unchanged; the engine's locator fixtures through the
  loader; a third Playwright project on `examples/next-admin`; a production build check.
- **Constraints**: one locator algorithm (rule 3), first attribute (rule 5), JSX seen before
  it is compiled (rule 6), same origin (rule 7). The dev service listens on loopback only.

## Constitution Check

| Principle | Status |
| --- | --- |
| II Code is the truth | The engine and its ops are untouched |
| V Guards | The dev service applies the same caller guard. The designer proxy still checks first |
| VIII Test first | The extraction is proven by suites that already exist |
| IX Verify APIs | The spike is the verification, and it comes first |

A second process beside `next dev` is added complexity. Justified: Next.js has no dev-server
plugin API that could host the engine routes. The simpler alternative (route handlers inside
the user's app) puts Trivia code in the user's tree and was rejected.

## Project Structure

```
packages/dev-service/            extracted: service, http, guard, mcp, refine, blueprint, routes, host
  src/standalone.ts, bin/trivia-dev.js
  src/stamp.ts                   insertion and source-map code shared by both hosts
packages/vite-plugin-ast-locator/   transform.ts plus a DevHost and the middleware mount
packages/next/
  src/loader.cjs
  src/with-trivia.ts
  src/host.ts                    DevHost for Next.js: routes from app/, module resolution
  src/launcher.ts, bin/trivia-next.js
packages/designer/server/        the second proxy target and its guard tests
examples/next-admin/
e2e/next/                        the third Playwright project
```

## Approach

1. The spike, in a scratch folder outside the workspace. Answers into LLD-13.
2. Move files into `packages/dev-service` with no content change. Gate.
3. Introduce `DevHost`. Gate.
4. The standalone server and its guard tests.
5. The loader, proven on the locator fixtures.
6. `withTrivia`, the launcher, the designer's proxy routing.
7. The example app and the Playwright project.
8. Routes from `app/`, then the Refine adapter's host differences.

## Risks

- **The loader does not work under Turbopack.** Known within the first days. Two fallbacks are
  named, and the rest of the plan does not depend on which one is used.
- **How the designer learns of a re-render.** To be read from the code in step 1. A
  host-neutral signal is added only if the current one is tied to Vite.
- **A large refactor of a tested package.** Done as moves first, interface second, with the
  full gate after each.
