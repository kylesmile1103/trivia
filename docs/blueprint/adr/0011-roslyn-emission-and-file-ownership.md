# ADR-0011: C# emission with Roslyn; `*.g.cs` owned by the generator

- Status: Accepted
- Date: 2026-11-25
- Requirements: FR-NC-01 to FR-NC-03, FR-NC-08, FR-NC-11

## Context

On the React side a page is ejected once and then edited as code (ADR-0003). A backend is
different: its entities, records and CRUD endpoints are a mechanical function of the model, and
the model keeps changing. C# has a clean way to keep generated and hand-written code apart:
partial types and partial methods.

## Decision

- `trivia-dotnet` is a C# tool that builds syntax trees with Roslyn's `SyntaxFactory` and
  prints them with `NormalizeWhitespace`.
- Two kinds of file exist. **Generated** files end in `.g.cs`, start with an auto-generated
  header carrying the generator version and the SHA-256 of the body, and are overwritten on
  every run. **Scaffold** files are created when missing and never touched again.
- Hand-written logic goes in scaffold files: the other half of each partial class, with
  partial-method hooks and the bodies of custom operations.
- A generated file whose body no longer matches its header was edited by hand. The run stops
  unless forced.
- The tool emits a file plan first. Writing is a separate step.

So for the backend, generated files are artifacts of the model. That does not contradict
ADR-0003: the user's code is still never overwritten, because it lives in different files.

## Consequences

- A model change is `plan`, review, `write`, and a migration. Diffs touch `.g.cs` files only.
- Roslyn guarantees syntactically valid output. The emitted solution's build is the semantic
  check.
- Trivia's engine does not edit C#. Byte-preserving day-2 editing of backend code is not on
  offer.

## Alternatives

- **Source generators at build time.** No generated files in the repository, but the code is
  invisible in review and harder to debug.
- **Text templates.** Simpler to start, no guarantee of valid syntax, harder to keep
  deterministic.
