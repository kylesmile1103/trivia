# ADR-0012: Aspire for orchestration; OpenAPI closes the loop

- Status: Accepted
- Date: 2026-11-25
- Requirements: BR-09, FR-AS-01 to FR-AS-08

## Context

A generated solution has a database, a migration step, an API and a web app. Aspire 13.x
orchestrates all four locally, including JavaScript apps, and adds a dashboard, service
discovery and OpenTelemetry. It is not a runtime framework: it gives no auth, tenancy or
connectors. Trivia already turns an OpenAPI document into a typed client and a manifest, and
its drift tool compares pages against that manifest.

## Decision

- Every generated solution has an Aspire AppHost and a ServiceDefaults project.
- The API's build writes its OpenAPI 3.1 document into the web app. `pnpm sync` runs
  contract-sync on it.
- The frontend never reads the model document. Its only view of the backend is the contract.
- In development the web app proxies `/api` to the API using Aspire's service discovery
  variables, so there is one origin and no CORS configuration.

## Consequences

- Frontend and backend generation are decoupled: Phase 1 works against any OpenAPI contract,
  and a hand-written backend remains possible.
- A model change reaches the pages as contract drift, with a fix per issue, through tools that
  already exist.
- Developers need the .NET SDK, the Aspire CLI and a container runtime for the backend half.
- Aspire's API surface is still moving. The AppHost is a scaffold file, small enough to fix by
  hand.

## Alternatives

- **Docker Compose only.** Fewer tools, no dashboard, no service discovery, hand-written wiring.
- **TypeSpec as the contract source.** One spec for C# and TypeScript, but a third language and
  a second generator. Worth another look if the contract should outrank the C#.
