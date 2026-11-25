# Architecture decision records: Trivia Blueprint

One file per decision. Status is **Accepted** when it follows from the research report Kyle
agreed to on 2026-11-25 or from his answers that day, and **Proposed ⚑** when the agent made the
call while writing the designs and it waits for review. A changed decision gets a new record
that supersedes the old one. Records are not edited after acceptance, except their status line.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-clean-room-no-port.md) | Clean room: concepts from Openblocks, no code | Accepted |
| [0002](0002-grow-trivia-with-a-blueprint-layer.md) | Grow Trivia with a blueprint layer (strategy C) | Accepted |
| [0003](0003-one-way-eject.md) | One-way eject, guarded by a lock | Accepted |
| [0004](0004-preview-is-compiled-code.md) | No interpreter: the preview is the compiled code | Accepted |
| [0005](0005-normalized-versioned-json-documents.md) | Blueprints are normalized, versioned JSON documents in git | Accepted |
| [0006](0006-typescript-expression-subset.md) | Bindings are a TypeScript expression subset, analyzed with OXC | Accepted |
| [0007](0007-react-emission-through-engine-ops.md) | React emission: printed new files, engine Ops for existing ones | Accepted |
| [0008](0008-nextjs-is-a-target-not-the-core.md) | The editor stays on Vite; Next.js is a target and a supported host | Accepted |
| [0009](0009-generated-frontends-are-refine-apps.md) | Generated frontends are Refine + shadcn apps | Proposed ⚑ |
| [0010](0010-dotnet-minimal-api-slices-on-postgres.md) | Backend: .NET 10 minimal API slices, EF Core, PostgreSQL | Accepted |
| [0011](0011-roslyn-emission-and-file-ownership.md) | C# emission with Roslyn; `*.g.cs` owned by the generator | Accepted |
| [0012](0012-aspire-and-the-openapi-contract-loop.md) | Aspire for orchestration; OpenAPI closes the loop | Accepted |
| [0013](0013-guarded-blueprint-ops-for-agents.md) | Agents write blueprints through guarded ops over MCP | Accepted |
| [0014](0014-hosted-runtime-deferred.md) | The hosted runtime and its dependencies are deferred | Accepted |
| [0015](0015-trivia-on-nextjs-loader-and-dev-service.md) | Trivia on Next.js: a stamping loader and a dev service | Proposed ⚑ |
| [0016](0016-styling-with-tokens.md) | Styling: theme tokens as CSS variables, classes as written | Accepted |
