# ADR-0010: Backend: .NET 10 minimal API slices, EF Core, PostgreSQL

- Status: Accepted
- Date: 2026-11-25
- Requirements: BR-08, FR-NC-04 to FR-NC-10

## Context

The request was to replace Openblocks' Spring WebFlux server with .NET 10. WebFlux is not
obsolete. The reasons that hold are the owner's skills, one language for the backend and for
its generator, and .NET 10's built-in OpenAPI generation, which feeds Trivia's contract sync.
There is no server to port either way (ADR-0001): what gets built is a generator of backends,
not a platform backend.

Asked which shape generated backends should take, Kyle chose minimal API slices on PostgreSQL
over a Clean Architecture profile and over pluggable profiles.

## Decision

A generated backend is one ASP.NET Core project on .NET 10:

- one folder per entity under `Features/`, holding its endpoint group, records and hooks;
- minimal APIs, with the built-in validation and OpenAPI support;
- EF Core 10 with Npgsql, one `DbContext`, migrations applied by a separate service;
- RFC 9457 problem details for errors.

No mediator, no repository layer, no layered projects.

## Consequences

- Emitters are small, and the output is close to what a developer would write by hand.
- SQL Server and Oracle, and house architectures in banks, are not served. The emitters sit
  behind one interface per file kind, so a second profile can be added without touching the
  model.
- No reactive database driver or MongoDB anywhere.

## Alternatives

- **Clean Architecture with handlers.** Heavier emitters, more files per entity, closer to
  enterprise convention. Offered and declined.
- **Keep a JVM backend.** No fit with the owner's skills or with the C# generator.
