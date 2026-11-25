# Implementation Plan: Aspire solution and contract loop

**Branch**: `010-aspire-solution-contract-loop` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: [LLD-10](../../docs/blueprint/lld/LLD-10-aspire-solution-and-contract-loop.md) · ADR-0012

## Summary

Scaffold projects for AppHost, ServiceDefaults and MigrationService in `trivia-dotnet`; a data
provider and a dev proxy in the web templates; build-time OpenAPI output wired to
contract-sync; and a CLI command that runs the loop.

## Technical Context

- **Languages**: C# (scaffolds), TypeScript (data provider, proxy, CLI).
- **Dependencies**: Aspire 13.x hosting packages for PostgreSQL and JavaScript apps,
  `Aspire.Hosting.Testing` in tests. Versions pinned after reading the current docs.
- **Testing**: build test, Aspire integration test (container runtime), a contract test in
  Node, a data provider test against the running API.
- **Constraints**: scaffold files only. Nothing here is regenerated.

## Constitution Check

| Principle | Status |
| --- | --- |
| VII User owns output | Every file is a scaffold. The data provider depends only on `@refinedev/core` |
| IX Verify APIs | Aspire resource method names are read from the docs for the pinned version |
| IV Plans, not writes | The CLI runs existing steps in order. It adds no new write path |

No violations.

## Project Structure

```
dotnet/src/Trivia.Blueprint.Codegen/Scaffold/
  AppHost/            Program.cs, csproj
  ServiceDefaults/    Extensions.cs, csproj
  MigrationService/   Worker.cs, Program.cs, csproj
  Api/                csproj properties for OpenAPI output
packages/blueprint-compiler/templates/vite-refine/
  src/providers/data-provider.ts
  vite.config.ts      the /api proxy from service discovery variables
  package.json        the sync script
packages/blueprint-compiler/src/cli.ts        + backend
packages/blueprint-compiler/test/contract-loop.test.ts
dotnet/tests/Trivia.Blueprint.Codegen.Tests/Integration/AppHostTests.cs
```

## Approach

1. Verify Aspire and OpenAPI build-time APIs. Pin versions.
2. Scaffolds, then the whole-solution build test.
3. MigrationService and the start order.
4. OpenAPI output and the contract test.
5. Data provider with its operator table, tested against the API.
6. Dev proxy.
7. The CLI's `backend` command and the lock's model revision.
8. Compose publishing.

## Risks

- **Aspire API changes** between minor versions. Scaffold files are short and the user's to fix.
- **The contract test depends on contract-sync heuristics.** That is the point of it. A
  failure means LLD-09's conventions or the heuristics moved, and one of them must follow.
