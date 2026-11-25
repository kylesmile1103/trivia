# Implementation Plan: Next.js code generation target

**Branch**: `012-nextjs-codegen-target` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: [LLD-12](../../docs/blueprint/lld/LLD-12-nextjs-codegen-target.md) · ADR-0008, ADR-0009

## Summary

Refactor the compiler onto a target interface, then add `next-refine`: a boundary algorithm
over expression tiers, server-side fetching of server-tier queries, an App Router template,
file-based previews, and the AppHost's JavaScript app resource.

## Technical Context

- **Language**: TypeScript in `@trivia/blueprint-compiler`. A few lines of C# scaffold.
- **Dependencies**: none in the compiler. The template pins Next.js, React and Refine's
  Next.js router binding after reading their current documentation.
- **Testing**: unit tests of the boundary algorithm, golden files, `tsc`, `next build` (CI),
  one HTTP-level e2e under the AppHost.
- **Constraints**: lowering stays shared. Nothing in a blueprint names the target except
  `app.targets.web`.

## Constitution Check

| Principle | Status |
| --- | --- |
| III One semantics | Client regions are printed by the same printer as the Vite target |
| VI Deterministic | The boundary algorithm is a pure function of the IR |
| IX Verify APIs | Caching, `proxy.ts`, async `params` and Refine's initial data options are read from current docs first |
| X Stay small | No streaming, no server actions |

Preview files on disk are a second preview mechanism. Justified: Next.js compiles only files.
The simpler alternative (no preview on Next.js) was rejected because preview is how drafts are
checked (BR-06). The files are gitignored, outside history, and removed on eject and on stop.

## Project Structure

```
packages/blueprint-compiler/
  src/targets/target.ts               the interface
  src/targets/vite-refine/            moved onto it, unchanged output
  src/targets/next-refine/
    boundaries.ts     groups, lowest common ancestors, crossing props
    files.ts          page.tsx and view modules
    server-data.ts    awaited queries, header forwarding, notFound
    routes.ts         resource registration in app/providers.tsx
    caching.ts        public pages only
    preview.ts        file-based preview plan
  templates/next-refine/
  fixtures/next/      golden files for kit and MVP
dotnet/src/Trivia.Blueprint.Codegen/Scaffold/AppHost/   the JavaScript app branch
e2e/blueprint-next.spec.ts
```

## Approach

1. The target interface and the Vite refactor, golden files unchanged.
2. The template, by hand, building and running under the AppHost.
3. Contract pages: a server entry and one client view.
4. The boundary algorithm, from its unit tests.
5. Server-tier queries and initial data.
6. Rewrites and credential forwarding.
7. Caching for public pages.
8. File-based previews (after spec 013's spike answers question 6).

## Risks

- **Next.js API changes** around caching. Confined to `caching.ts` and the template.
- **Refine's server-side story** (initial data, router binding). Verified first. If initial
  data cannot be handed to a hook cleanly, the fallback is a hydrated query client, which costs
  one more provider in the template.
- **Boundary surprises.** The algorithm is conservative: when in doubt, the boundary moves up.
