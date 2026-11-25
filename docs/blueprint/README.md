# Trivia Blueprint: document index (2026-11-25)

The blueprint track adds day 1 to Trivia: a typed app description that compiles to a real
React + shadcn and ASP.NET Core codebase, which Trivia then edits. These documents came out of
the Openblocks port assessment and Kyle's choices after it (strategy C, clean room, one-way
eject, minimal API slices on PostgreSQL, Phases 0 to 3 in depth).

See the task lists in `specs/` for implementation status. The generated .NET solution
supports Vite and Next.js.

## Run a generated .NET and Vite app

Use the .NET 10 SDK, Aspire CLI 13.6.5, a running container runtime, Node and pnpm. Make
`trivia-blueprint` and `trivia-dotnet` available from your Trivia build or distribution.

```sh
trivia-blueprint new backoffice --api dotnet-minimal
cd backoffice
# Run the printed pnpm and shadcn setup in web/, then author the model and pages in web/blueprint/.
trivia-blueprint backend --migration Initial
trivia-blueprint eject
aspire run
```

The backend command generates the solution, restores its pinned EF tool, adds the migration,
builds the API, syncs the web client and reports contract drift. Commit the OpenAPI document
under `web/openapi/` with your changes. After changing the model, run the backend command
again and pass `--migration <Name>` when the database schema changes.

Open the web endpoint in the Aspire dashboard after the migration completes. When running
Vite on its own, set `API_URL` to the API origin. If Aspire reports a missing or stopped
container runtime, run `aspire doctor` for its status and start the selected runtime.
[Aspire troubleshooting](https://aspire.dev/get-started/troubleshooting/) ·
[Solution and contract loop](lld/LLD-10-aspire-solution-and-contract-loop.md).

For a nested web folder such as `clients/admin`, pass `--web-dir clients/admin` to
`new` and `backend` from the solution directory. You can also run `backend` and
`eject` from the web folder.

## Run a generated .NET and Next.js app

Use the same toolchain and choose the Next.js target when creating the project.

```sh
trivia-blueprint new backoffice --target next-refine --api dotnet-minimal
cd backoffice
# Run the printed pnpm and shadcn setup in web/, then author the model and pages in web/blueprint/.
trivia-blueprint backend --migration Initial
trivia-blueprint eject
aspire run
```

Open the web endpoint in Aspire after migration. Generated show and edit routes fetch
their initial records on the server. Browser requests to `/api` use the same origin as
the web app and Next.js rewrites them to the backend.

When running Next.js outside Aspire, set `TRIVIA_API_ORIGIN` to the API origin before
starting development or building for production. To expose the current identity to a
server expression, set `TRIVIA_IDENTITY_PATH` to a trusted path on that API.

The designer and MCP can preview drafts at `/__blueprint/<Name>`. Pass values for
dynamic route parameters in the preview URL's query string. Stop the Trivia dev service
to clean up previews before building for production.

Run `TRIVIA_NEXT_BUILD=1 pnpm exec nx test blueprint-compiler` to typecheck and build an
emitted app. The `blueprint-next` Playwright project exercises the generated app through
Aspire with the API and PostgreSQL. [Next.js code generation](lld/LLD-12-nextjs-codegen-target.md).

## Reading order

1. [BRD.md](BRD.md): why, for whom, what is in and out, success measures.
2. [HLD.md](HLD.md): the architecture on a few pages.
3. [adr/](adr/README.md): sixteen decisions, two of them waiting for review (⚑).
4. [SRS.md](SRS.md): the numbered requirements that specs and tests cite.
5. [lld/](lld/): one design per feature.
6. `specs/NNN-*/`: Spec Kit features (`spec.md`, `plan.md`, `tasks.md`), governed by
   `.specify/memory/constitution.md`.

## Features

| # | Feature | Phase | LLD | Spec | Requirements |
| --- | --- | --- | --- | --- | --- |
| 001 | Blueprint schema and store | 0 | [LLD-01](lld/LLD-01-blueprint-schema.md) | [spec](../../specs/001-blueprint-schema/spec.md) | FR-BP |
| 002 | Component manifests | 0 | [LLD-02](lld/LLD-02-component-manifests.md) | [spec](../../specs/002-component-manifests/spec.md) | FR-MF |
| 003 | Expression compiler | 0 | [LLD-03](lld/LLD-03-expression-compiler.md) | [spec](../../specs/003-expression-compiler/spec.md) | FR-EX |
| 004 | Agent surface (HTTP, MCP) | 0 | [LLD-04](lld/LLD-04-agent-surface.md) | [spec](../../specs/004-blueprint-agent-surface/spec.md) | FR-AG |
| 005 | React code generation (Vite) | 1 | [LLD-05](lld/LLD-05-react-codegen.md) | [spec](../../specs/005-react-codegen-vite/spec.md) | FR-RC |
| 006 | Component kit | 1 | [LLD-06](lld/LLD-06-component-kit.md) | [spec](../../specs/006-component-kit/spec.md) | FR-KT |
| 007 | Designer Blueprint panel | 1, 2 | [LLD-07](lld/LLD-07-designer-blueprint-panel.md) | [spec](../../specs/007-designer-blueprint-panel/spec.md) | FR-DS |
| 008 | Data model DSL | 2 | [LLD-08](lld/LLD-08-data-model-dsl.md) | [spec](../../specs/008-data-model-dsl/spec.md) | FR-DM |
| 009 | .NET code generation | 2 | [LLD-09](lld/LLD-09-dotnet-codegen.md) | [spec](../../specs/009-dotnet-codegen/spec.md) | FR-NC |
| 010 | Aspire solution and contract loop | 2 | [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md) | [spec](../../specs/010-aspire-solution-contract-loop/spec.md) | FR-AS |
| 011 | MVP slice: a CRUD admin end to end | 2 | none (a test slice) | [spec](../../specs/011-mvp-crud-admin/spec.md) | FR-MVP |
| 012 | Next.js code generation target | 3 | [LLD-12](lld/LLD-12-nextjs-codegen-target.md) | [spec](../../specs/012-nextjs-codegen-target/spec.md) | FR-NX |
| 013 | Trivia on Next.js | 3 | [LLD-13](lld/LLD-13-trivia-on-nextjs.md) | [spec](../../specs/013-trivia-on-nextjs/spec.md) | FR-TN |

Phase 4 (a hosted runtime) is described in HLD section 11 only, behind a demand gate (ADR-0014).

## Build order

```
001 ─┬─ 002 ─┬─ 004 ── 005 ─┬─ 006 ─┐
     └─ 003 ─┘              └─ 007 ─┤
001 ── 008 ── 009 ── 010 ───────────┴─ 011 (MVP)
005, 006, 010 ── 012          013 is independent (needs 004's adapter to exist, since it moves)
```

Each `tasks.md` lists its own dependencies. Within a feature, tests come before the code they
cover.

## Using the specs with Spec Kit

The folder layout is Spec Kit's: a constitution in `.specify/memory/` and one folder per
feature under `specs/`. The specs were written by hand from the designs, so `/speckit.specify`
and `/speckit.plan` have nothing left to generate. To get the slash commands and templates for
later features, run `specify init --here` for your agent, and check afterwards that it left
`.specify/memory/constitution.md` as it is. Then, per feature: `/speckit.analyze` to
cross-check spec, plan and tasks against the constitution, and `/speckit.implement` to work
through `tasks.md`.

Without Spec Kit the files are plain Markdown: give an agent the feature folder, the LLD it
points to and the constitution.

## Decisions waiting for you (⚑)

| Decision | Where | Why it matters |
| --- | --- | --- |
| Generated frontends are Refine + shadcn apps, not plain TanStack Query | ADR-0009 | It is what lets the existing day-2 tools work on emitted apps, and it departs from the research report's suggestion |
| Trivia on Next.js through a stamping loader and a separate dev service | ADR-0017 | The spec 013 spike verified Turbopack loader and route discovery behavior |
| Dependencies of expressions are computed, not stored in the document | ADR-0006 | Departs from the research report |
| The JSX-like projection is read-only | ADR-0005 | Agents write through ops only |
| New files follow the project's semicolon and quote style, with no formatter run | ADR-0007 | Determinism over house formatting |
| A fifth designer tab with icons and tooltips | LLD-07 | Layout work in a 272 px column |
| Previews on Next.js are files in a gitignored folder | LLD-12 | The spec 013 spike verified that Next.js discovers new routes and removes them during development |
| Day 1 joins the product for this track | ADR-0002, BRD section 8 | It supersedes a line of `docs/product.md`, which is not yet edited |

BRD section 10 lists four open questions with the defaults taken.

## What was verified and what was not

- **From the research (2026-11-25):** Openblocks' last release was March 2023 and it is
  AGPL-3.0; Lowcoder is its live fork under the same licence; Next.js was at 16.x with no 17
  announced; Aspire was at 13.x with JavaScript app support; .NET 10 is the current LTS;
  shadcn made Base UI its default in July 2026.
- **From this repository (read on 2026-11-25):** the engine ops and envelope (`docs/api.md`),
  the MCP tools (`docs/mcp.md`), the manifest shape (`docs/data-provider.md`), the product
  decisions and slices (`docs/product.md`), the layout rules (`docs/architecture.md`,
  `CLAUDE.md`), and that `createFile` writes only `.tsx` and `.jsx`.
- **From the Next.js implementation:** the emitted app builds with Next.js 16.4.6 and
  runs through Aspire 13.6.5. Playwright checks record HTML before hydration, same-origin
  API requests, and HTTP status handling. The spec 013 spike verified Turbopack's loader
  behavior and its discovery of preview routes created on disk.
- **Estimates** (6 to 9 months to the MVP) are the research's and are inference.
- The licence reading in ADR-0001 is not legal advice.
