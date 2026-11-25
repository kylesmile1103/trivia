# HLD: Trivia Blueprint (2026-11-25)

The architecture of the blueprint track. Requirements are in `SRS.md`, decisions in `adr/`,
each feature's design in `lld/`. Where this file and `CLAUDE.md` disagree, `CLAUDE.md` wins.

## 1. What is being built

Today Trivia edits a React app that already exists. This track adds the step before: a
**blueprint** that describes an app (pages and a data model), and compilers that turn it into
the code Trivia edits.

```
        author                    compile                      edit forever
 agent (MCP) ─┐            ┌─ React + shadcn + Refine ─┐
 designer    ─┼─ blueprint ┤   (Vite, then Next.js)    ├─ Trivia: canvas, inspector,
 CLI         ─┘  (JSON in  └─ ASP.NET Core + EF Core ──┘   columns, fields, drift
                  git)          + Aspire AppHost            (byte-preserving ops)
                                      │
                                      └── OpenAPI ── contract-sync ── manifest ──┘
```

Nothing from Openblocks or Lowcoder is ported. Three of their ideas are kept as concepts: a
tree of typed components, values that depend on other values, and queries as part of the app
description (ADR-0001).

## 2. Principles

1. **The code is the truth after eject.** A blueprint scaffolds. It is not a second source that
   has to be kept in step (ADR-0003).
2. **One semantics.** The preview is the compiled module. There is no interpreter to drift
   away from the compiler (ADR-0004).
3. **Reuse what Trivia has.** Contract pages come from the existing Refine generator. Files
   are written through engine Ops. Props come from the engine's prop analyzer. Undo is the
   shared history.
4. **Everything is checked when saved.** Schema, references, manifests and expressions are
   validated before anything compiles. The compiler assumes a valid blueprint.
5. **Deterministic and local.** Same inputs, same bytes. No network, no telemetry.
6. **Plans, not direct writes.** Generators return Ops or a file plan. One path applies them.
7. **The user owns every emitted line.** Components arrive through the shadcn registry into
   the user's project. Emitted apps import nothing from `@trivia/*`.

## 3. Logical architecture

```
┌──────────────────────────── authoring ────────────────────────────┐
│ designer: features/blueprint   MCP: trivia_blueprint_*   CLI       │
└───────────────┬──────────────────────┬─────────────────────┬──────┘
                │ HTTP /@trivia/api/blueprint/*              │ direct
┌───────────────▼──────────────────────▼─────────────────────▼──────┐
│ dev service (plugin today, framework-neutral in Phase 3)           │
│   blueprint adapter: store, validate, preview, plan, backend       │
│   EngineService: one edit queue, one undo history                  │
└──────┬───────────────┬─────────────────────┬──────────────┬───────┘
       │               │                     │              │ child process
┌──────▼─────┐ ┌───────▼────────┐ ┌──────────▼────────┐ ┌───▼──────────────┐
│ @trivia/   │ │ @trivia/       │ │ @trivia/engine    │ │ trivia-dotnet    │
│ blueprint  │ │ blueprint-     │ │ (napi)            │ │ (C#, Roslyn)     │
│ schema,    │ │ compiler       │ │  trivia_oxc_engine│ │ model to C#,     │
│ ops,       │ │ page IR,       │ │   + replaceFile   │ │ Aspire solution  │
│ validate,  │ │ TSX printer,   │ │  trivia_expr      │ └──────────────────┘
│ manifests  │ │ targets, kit   │ │   analyze, emit   │
└────────────┘ └────────────────┘ └───────────────────┘
```

### Components

| Component | Where | New or changed | Responsibility | LLD |
| --- | --- | --- | --- | --- |
| `@trivia/blueprint` | `packages/blueprint` | new | Document types, JSON Schemas, canonical serialization, BlueprintOps, validation, migrations, projection, manifest resolution | 01, 02, 08 |
| `trivia_expr` | `crates/trivia_expr` | new | Parse the expression subset, extract dependencies, classify tiers, emit renamed TypeScript | 03 |
| `@trivia/engine` | `crates/trivia_napi` | changed | Exposes `trivia_expr`; the engine gains `replaceFile` | 03, 05 |
| `@trivia/blueprint-compiler` | `packages/blueprint-compiler` | new | Page IR, TSX printer, targets (`vite-refine`, `next-refine`), kit manifests, app templates, lock, the `trivia-blueprint` CLI | 05, 06, 12 |
| Blueprint adapter | `packages/vite-plugin-ast-locator/src/blueprint` | new | HTTP routes and MCP tools over the store and the compiler; previews; plans | 04 |
| Refine adapter | `packages/vite-plugin-ast-locator/src/refine` | reused | Contract pages, route and resource registration | 05 |
| Blueprint panel | `packages/designer/src/features/blueprint` | new | Pages, nodes, model, preview, eject, backend | 07 |
| `trivia-dotnet` | `dotnet/Trivia.Blueprint.Codegen` | new | Model to C# with Roslyn; solution, AppHost and service templates; ownership rules | 09, 10 |
| contract-sync | `packages/contract-sync` | reused | OpenAPI to typed client and manifest | 10 |
| `@trivia/dev-service` | `packages/dev-service` | new in Phase 3, extracted from the plugin | EngineService, HTTP API and MCP without Vite | 13 |
| `@trivia/next` | `packages/next` | new in Phase 3 | Locator stamping loader for `next dev`, the dev service launcher | 13 |

Dependencies point one way: designer, MCP and CLI call the dev service or the packages; the
adapter calls `@trivia/blueprint-compiler`, which calls `@trivia/blueprint` and `@trivia/engine`.
`trivia-dotnet` reads blueprint files and shares no code with the Node side: the model's JSON
Schema is the contract between them.

## 4. Key flows

### 4.1 Author, validate, preview, eject (Phases 0 and 1)

```
agent or designer ── BlueprintOp[] (baseRev) ──► store
   store: check revs ► apply ► validate ► canonical write ► one history entry
   ◄── new revs + diagnostics

preview(page) ──► compiler: IR ► TSX ──► served at /@trivia/preview/<id>.tsx
   canvas loads the page's preview route; trivia_screenshot shows it to an agent

eject(pages) ──► plan: createFile per page + resource entry + <Route> (Refine adapter)
   refused with 422 when a component is missing, 409 when a file changed since its eject
   designer or MCP applies it through /batch ► one undo entry ► lock updated
```

After eject a page's files belong to the developer. The blueprint page stays as a record and
can be ejected again only while its file still has the bytes that were written (FR-RC-08).

### 4.2 Model to backend to contract (Phase 2)

```
model.blueprint.json ──► trivia-dotnet plan ──► file plan (review) ──► write
   *.g.cs regenerated every time; scaffold files written once; migration added on request
dotnet build ──► web/openapi/api.openapi.json ──► pnpm sync (contract-sync)
   ──► src/api/generated + trivia.manifest.json ──► contract drift lists page fixes
```

The two halves treat regeneration differently on purpose (ADR-0003, ADR-0011). Backend
`*.g.cs` files are artifacts of the model, with partial classes for hand-written code. Frontend
pages are ejected once, and later model changes reach them as drift fixes, which are ordinary
byte-preserving edits.

### 4.3 Next.js (Phase 3)

The same blueprint compiles with the `next-refine` target. Expression tiers decide which
subtrees are server components, which queries are fetched on the server, and where the
`"use client"` boundaries go. The designer talks to a dev service running beside `next dev`,
and a loader stamps locators (LLD-12, LLD-13).

## 5. Data architecture

| Artifact | Location | Owner | Notes |
| --- | --- | --- | --- |
| App document | `blueprint/app.blueprint.json` | author | Name, targets, theme tokens, navigation, auth mode |
| Model document | `blueprint/model.blueprint.json` | author | Enums, entities, relations, API options |
| Page documents | `blueprint/pages/<Name>.page.json` | author | One file per page, flat maps |
| Manifest overrides | `blueprint/manifests/*.manifest.json` | author | Optional |
| Lock | `blueprint/blueprint.lock.json` | compiler | Ejected files and their hashes |
| Contract | `web/openapi/api.openapi.json`, `web/trivia.manifest.json` | build | From the API build and contract-sync |
| Generated C# | `src/<App>.Api/**/*.g.cs` | `trivia-dotnet` | Overwritten on every run |
| Everything else | the repository | developer | Edited by hand, by Trivia or by an agent |

The blueprint directory sits inside the web app's root (`web/blueprint/`), so the engine's
path containment and the shared undo history cover it. `trivia-dotnet` is given that path.

A generated solution:

```
<app>/
  <App>.slnx
  src/<App>.AppHost/            Aspire AppHost
  src/<App>.ServiceDefaults/
  src/<App>.Api/                minimal API, EF Core, Features/<Entity>/
  src/<App>.MigrationService/
  web/                          the React app (Vite or Next.js): Trivia's root
    blueprint/                  the blueprint and its lock
    openapi/api.openapi.json
    src/                        pages, components/ui (the user's shadcn), api/generated
```

## 6. Interfaces

| Interface | Summary | Defined in |
| --- | --- | --- |
| BlueprintOp | `createPage`, `addNode`, `setProp`, `setBinding`, `setQuery`, `setEntity`, `setField` and the rest, each with `baseRev` | LLD-01, LLD-08 |
| HTTP | `GET /blueprint`, `/blueprint/doc`, `/blueprint/components`; `POST /blueprint/patch`, `/preview`, `/plan`, `/backend` | LLD-04 |
| MCP | `trivia_blueprint_get`, `_patch`, `_preview`, `_eject`, `_backend` | LLD-04 |
| napi | `analyzeExpressions(json)`, `emitExpressions(json)` | LLD-03 |
| Engine Op | `replaceFile { file, expectedHash, content }` | LLD-05 |
| CLI | `trivia-blueprint` (`new`, `validate`, `compile`, `eject`) and `trivia-dotnet` (`plan`, `write`, `check`, `migrate`) | LLD-05, LLD-09 |
| Generated API | `/api/v1/<plural>` CRUD, list conventions, problem details | LLD-09 |

## 7. Deployment views

**Authoring (developer machine).** As today: the app's dev server with the Trivia plugin, the
designer at `:4400/__trivia/`, an MCP client. New: `dotnet` and a container runtime when the
backend half is used.

**Generated solution, development.** `aspire run` starts PostgreSQL (container), the migration
service, the API and the web dev server. The web app proxies `/api` to the API through Aspire's
service discovery variables, so the browser sees one origin.

**Generated solution, production.** Out of the MVP's must-haves. The AppHost can publish to
Docker Compose (FR-AS-09). With the Vite target the web app is static files; with the Next.js
target it is a Node service in front of the API.

## 8. Security

- The blueprint API sits under `/@trivia/api/`, behind the existing loopback, Host and Origin
  checks. No new listener is opened in Phases 0 to 2. Phase 3's dev service applies the same
  guard itself.
- Expressions are parsed, never evaluated, by the tool. They only ever run as compiled code in
  the user's app, where `tsc` has checked them.
- `trivia-dotnet` is started with an argument array and a fixed executable name. Its output
  paths are checked against the solution root before anything is written.
- Generated APIs: EF Core parameterizes queries, sort and filter fields are checked against
  the model's allowlists, validation runs before handlers, problem details carry no stack.
- Secrets never enter a blueprint. Connection strings come from Aspire resources.

## 9. Quality gates

| Gate | Covers |
| --- | --- |
| `pnpm check` | Build, typecheck, lint and unit tests of every project, including the new packages and the crate |
| `pnpm e2e` | Designer panel, preview, eject, undo; the kit fixture; the Next.js project in Phase 3 |
| `dotnet test` in `dotnet/` | Emitter snapshots, the emitted solution's build, the API integration test |
| Golden files | Emitted TSX and C# for the fixtures, byte for byte |
| `tsc` and `next build` on emitted apps | FR-RC-05, FR-NX-08 |
| `specs/011-mvp-crud-admin` | The acceptance test for Phases 0 to 2 |

The Nx release configuration gains the commit areas `blueprint:`, `compiler:` and `dotnet:`.

## 10. Phases

| Phase | Features (spec) | Depends on |
| --- | --- | --- |
| 0 | 001 schema, 002 manifests, 003 expressions, 004 agent surface | the current engine and plugin |
| 1 | 005 React codegen, 006 kit, 007 Blueprint panel | Phase 0; an existing Refine app and contract |
| 2 | 008 data model, 009 .NET codegen, 010 Aspire and contract loop, 011 MVP | Phase 1 |
| 3 | 012 Next.js target, 013 Trivia on Next.js | Phase 1; 013 is independent of 012 |

Phase 1 needs no backend of its own: pages bind to whatever contract the app already has, as
the Data tab does today. Phase 2 makes the generated API the source of that contract.

## 11. Phase 4 outlook (not specified)

A hosted product would add what Trivia has never had: a server. It is described here only so
the earlier phases do not block it.

- **Control plane:** ASP.NET Core 10 with organisations, RBAC, blueprint storage in PostgreSQL
  (the same documents, as JSON columns), immutable published versions.
- **Runtime:** published apps are the compiled Next.js output, built per version. Still no
  interpreter: a build service compiles on publish.
- **Connectors:** out-of-process hosts behind a gRPC or HTTP contract. First-party SQL and REST
  only at first.
- **Gate:** build it when users who are not developers ask for it, and not before (ADR-0014).

What keeps it possible: blueprints are plain documents with stable ids (mergeable, storable
anywhere), the compiler is a pure function, and nothing in Phases 0 to 3 assumes a filesystem
beyond the store and the engine's writers.

## 12. Risks to the architecture

| Risk | Where it bites | Mitigation |
| --- | --- | --- |
| Custom pages need more of React than the IR models | LLD-05 | The escape hatch is eject, then code. The IR stays small on purpose |
| The Refine generator's output shape and the blueprint options drift apart | LLD-05 | One generator, called by both (FR-RC-02), with a test that compares them |
| Turbopack cannot run the stamping loader before its own transform | LLD-13 | A spike is the feature's first task, with two fallbacks listed |
| The API conventions and the data provider disagree | LLD-09, LLD-10 | The conventions are one document, and one integration test drives both |
| Version churn (OXC, Next.js, Aspire, shadcn) | everywhere | Pin exact versions, verify APIs against the docs when a phase starts |
