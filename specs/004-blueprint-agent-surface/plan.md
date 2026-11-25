# Implementation Plan: Blueprint agent surface

**Branch**: `004-blueprint-agent-surface` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: [LLD-04](../../docs/blueprint/lld/LLD-04-agent-surface.md) · ADR-0013

## Summary

A blueprint adapter in the Vite plugin, beside the Refine adapter: HTTP routes under
`/@trivia/api/blueprint`, five MCP tools, and one new `EngineService` method that writes
blueprint documents inside the edit queue and the undo history.

## Technical Context

- **Language**: TypeScript, in `packages/vite-plugin-ast-locator`.
- **Dependencies**: `@trivia/blueprint` (workspace). The MCP SDK already pinned in the
  repository.
- **Testing**: the plugin's Vitest suites against a copy of `examples/refine-admin`; one
  Playwright spec.
- **Constraints**: the envelope, codes and guard of `docs/api.md`. Structured results with
  hints as data (`docs/mcp.md`). No new listener.

## Constitution Check

| Principle | Status |
| --- | --- |
| IV Plans, not writes | Eject returns Ops applied through `/batch`. Documents go through the service queue |
| V Guards | `baseRev` end to end, `before` bytes checked at write time |
| VIII Test first | Docs examples pinned by tests, as for engine ops |
| Security | Existing guard, path containment, argument arrays for the child process |

No violations.

## Project Structure

```
packages/vite-plugin-ast-locator/src/
  blueprint/
    index.ts        registerBlueprintRoutes, blueprintTools
    store.ts        BlueprintStore wiring, directory option
    context.ts      validation context: manifests, contract, expressions
    summary.ts      BlueprintSummary, page status from the lock
    preview.ts      stub until spec 005
    plan.ts         stub until spec 005
    backend.ts      stub until spec 009
  api/service.ts    + writeDocuments(writes, label)
  api/history.ts    + entries for non-source files, if restoreFiles needs it
  api/http.ts       + route registration
  mcp/tools.ts      + the five tools
  options.ts        + blueprintDir
packages/vite-plugin-ast-locator/test/blueprint-*.test.ts
e2e/blueprint-mcp.spec.ts
docs/api.md, docs/mcp.md
```

## Approach

1. Verify whether the engine's `restoreFiles` handles non-source paths. Decide where the
   restore for document entries lives.
2. `writeDocuments` with its tests (conflict, atomicity, undo, redo).
3. Read routes: summary, doc, components.
4. Patch route.
5. MCP tools over the same functions, with input schemas generated from the zod ops.
6. Docs and their pinned examples.
7. The real-session check (SC-001).

## Risks

- **History and non-source files.** Settled by step 1 before anything else is built.
- **Tool overload for agents.** Five tools, validation folded into read and patch. Revisit
  after the real session.
