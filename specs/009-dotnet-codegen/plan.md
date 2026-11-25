# Implementation Plan: .NET code generation

**Branch**: `009-dotnet-codegen` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: [LLD-09](../../docs/blueprint/lld/LLD-09-dotnet-codegen.md) · ADR-0010, ADR-0011

## Summary

A C# console tool, `trivia-dotnet`, in a new `dotnet/` solution. It reads the model through
its JSON Schema, builds syntax trees with Roslyn, and writes a file plan under an ownership
rule: `*.g.cs` files are overwritten, scaffold files are written once.

## Technical Context

- **Language**: C# on .NET 10. The tool targets `net10.0` and is packed as a .NET tool.
- **Dependencies**: `Microsoft.CodeAnalysis.CSharp`, `System.CommandLine`. Tests: xUnit,
  Verify, Testcontainers for PostgreSQL. Emitted solutions: ASP.NET Core, EF Core 10, Npgsql,
  the OpenAPI packages. All pinned in `Directory.Packages.props`.
- **Testing**: snapshot tests per emitter, one build test, one integration suite (needs a
  container runtime, so it carries a trait).
- **Constraints**: verify minimal API validation, OpenAPI build-time generation and the Npgsql
  row version mapping against current documentation before coding (principle IX). No
  reflection or dynamic LINQ in emitted list code.

## Constitution Check

| Principle | Status |
| --- | --- |
| II Code is the truth | User code lives in scaffold files that are never rewritten. Hand-edited generated files are detected |
| IV Plans, not writes | `plan` is separate from `write`. A refusal writes nothing |
| VI Deterministic | Emitters are pure. Model order drives member order |
| VII User owns output | The emitted solution has no dependency on the tool |
| Security | Paths contained in `--root`. Filter and sort fields are compile-time switches |

Generated C# is regenerated, which differs from the one-way eject of pages. This is ADR-0011,
not a violation: the user's code is in other files.

## Project Structure

```
dotnet/
  Trivia.Blueprint.slnx, Directory.Packages.props, project.json (Nx: build, test)
  src/Trivia.Blueprint.Codegen/
    Program.cs
    Commands/      PlanCommand, WriteCommand, CheckCommand, MigrateCommand
    Model/         ModelDocument, AppDocument, ModelLoader
    Mapping/       TypeMap
    Emit/          EntityEmitter, EnumEmitter, DbContextEmitter, ContractsEmitter,
                   EndpointsEmitter, ListQueryEmitter, ApiProblemEmitter, ApiRegistrationEmitter
    Scaffold/      embedded text: Program.cs, csproj, slnx, entity and endpoint partials, custom operation stub
    Plan/          FilePlan, Ownership, Hashing, PlanWriter
    Migrations/    RenameRewriter
  tests/Trivia.Blueprint.Codegen.Tests/
    Fixtures/bank/           copied from packages/blueprint/fixtures by a build step
    Snapshots/
    Integration/
```

## Approach

1. Tool skeleton, model loader, the mapping fixture test.
2. Plan and ownership with trivial emitters, so the write rules are proven before the
   emitters grow.
3. Entity, enum, DbContext. Build test.
4. Contracts and endpoints for CRUD. Integration test.
5. List conventions.
6. Hooks and custom operations.
7. OpenAPI stability.
8. Migrations with the rename rewriter.
9. Auth.

## Risks

- **API churn in .NET 10 point releases** for validation and OpenAPI. Verified first, and kept
  inside `ApiRegistrationEmitter` and the csproj scaffold.
- **`NormalizeWhitespace` output style.** Accepted as the house style of generated files.
- **Slow tests.** Build and integration tests carry a trait and run in CI and before a release.
