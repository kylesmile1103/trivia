# SRS: Trivia Blueprint (2026-11-25)

Software requirements for the blueprint track. `BRD.md` says why, `HLD.md` and `lld/` say how,
`specs/` breaks each area into a Spec Kit feature. Requirement IDs here are the ones the specs
and tests cite.

## 1. Scope and definitions

The system adds to Trivia: a blueprint format, a compiler from blueprints to React and C#
source, an agent and designer surface for authoring, and support for Next.js. Phases 0 to 3 are
in scope. Phase 4 (hosted runtime) has no requirements here.

| Term | Meaning |
| --- | --- |
| Blueprint | The set of JSON documents under `blueprint/` describing an app: one app document, one model document, one document per page |
| Page kind | `list`, `create`, `edit`, `show` (derived from the contract) or `custom` (a node tree) |
| Node | One element of a custom page: a component or HTML element instance |
| Manifest | The typed description of a component: props, slots, events, exposed state |
| Binding | An expression that computes a prop, a query parameter or an action argument |
| Tier | Where an expression can be evaluated: `static`, `server` (request time) or `client` |
| Contract | The OpenAPI document and the `trivia.manifest.json` that contract-sync derives from it |
| Preview | A compiled page served as a module of the dev server before any file exists |
| Eject | Writing compiled pages into the project. After it, the code is the truth |
| Lock | `blueprint/blueprint.lock.json`: what was ejected, where, and the hash of the bytes written |
| Op | An engine operation of `docs/api.md` |
| BlueprintOp | A guarded operation on blueprint documents (LLD-01) |
| Generated file | A `*.g.cs` file the .NET generator owns and overwrites |
| Scaffold file | A file a generator creates once and never touches again |

## 2. Overall description

**Users:** developers (P1), coding agents over MCP (P2), reviewers (P3). See BRD section 4.

**Operating environment:** the developer's machine. Node 22.16+, pnpm, Rust 1.97+ for building
the engine, the .NET 10 SDK and a container runtime for the backend half. No cloud service.

**Product functions:**

1. Author: write and change blueprints through BlueprintOps (HTTP, MCP, designer, CLI).
2. Validate: schema, references, manifests and expressions, with precise diagnostics.
3. Preview: see a compiled page running in the app against real data.
4. Eject: write pages, routes and resources as one undo entry.
5. Generate backend: turn the model into an ASP.NET Core API and an Aspire solution.
6. Close the loop: API build, OpenAPI document, contract sync, drift fixes on pages.
7. Edit forever: Trivia's existing byte-preserving tools, on Vite and on Next.js.

**Constraints:** MIT and clean-room (NFR-07); the rules of `CLAUDE.md` hold for every edit to
existing source; emitted apps depend on nothing proprietary at runtime (NFR-10).

## 3. Functional requirements

Priority: M (must), S (should), C (could), for the phase named in the heading.

### 3.1 Blueprint schema (Phase 0, spec 001, LLD-01)

| ID | Requirement | P |
| --- | --- | --- |
| FR-BP-01 | A blueprint is `app.blueprint.json`, `model.blueprint.json` and `pages/<Name>.page.json` under one directory. Every document carries `$schema` and an integer `blueprintVersion` | M |
| FR-BP-02 | A page stores nodes, props, bindings, styles, control flow, state, queries and actions as flat maps keyed by id, not as a nested tree | M |
| FR-BP-03 | Ids are generated, prefixed and never reused. Node, query and state names are unique in their page and valid identifiers | M |
| FR-BP-04 | Serialization is canonical: loading and saving a canonical document gives the same bytes, and two equal documents serialize identically | M |
| FR-BP-05 | Validation runs in layers (schema, references, manifests, expressions) and returns diagnostics with a stable code, the document, a JSON pointer, a message and, where one exists, a fix hint. Invalid content never throws | M |
| FR-BP-06 | Older versions are migrated forward on load. A newer version is refused with `unsupported_version` and nothing is written | M |
| FR-BP-07 | Every change is a BlueprintOp. A batch is atomic across documents. Each op names the revision it was computed against, and node ops name the expected node type | M |
| FR-BP-08 | Sibling order is a fractional index, so inserting or moving a node changes that node only | M |
| FR-BP-09 | Page kinds `list`, `create`, `edit` and `show` need only a resource and options. `custom` pages carry a node tree | M |
| FR-BP-10 | A page has a read-only JSX-like projection, generated on request | S |

### 3.2 Component manifests (Phase 0, spec 002, LLD-02)

| ID | Requirement | P |
| --- | --- | --- |
| FR-MF-01 | A manifest declares a component's props, slots, events, exposed state, text content, default snippet, registry source and whether it needs the client | M |
| FR-MF-02 | Prop names, options and defaults come from the user's own component file through the engine's prop analyzer. The kit manifest adds only what static analysis cannot see | M |
| FR-MF-03 | A node whose component file is missing yields `missing_component` naming the registry item to add. Validation never installs anything | M |
| FR-MF-04 | A component of the user's library that the kit does not know gets a manifest derived from the analyzer alone | M |
| FR-MF-05 | A project can add or override manifests in `blueprint/manifests/` | S |
| FR-MF-06 | Lowercase node types are HTML elements, with a curated prop list | M |
| FR-MF-07 | The resolved manifests are available as JSON Schema, for agents and for editor completion | S |

### 3.3 Expression compiler (Phase 0, spec 003, LLD-03)

| ID | Requirement | P |
| --- | --- | --- |
| FR-EX-01 | Bindings are a documented subset of TypeScript expressions, parsed with OXC. Anything outside the subset is `expr_unsupported_syntax` with the offending span | M |
| FR-EX-02 | Free identifiers must be scope roots (`params`, `search`, `state`, `data`, `ui`, `user`, and locals such as `item`, `row`, `event`). Unknown roots and unknown members under known shapes are diagnostics | M |
| FR-EX-03 | Each expression's dependencies are extracted when the blueprint is validated, never at run time. They are computed, not stored in the document | M |
| FR-EX-04 | Each expression is classified `static`, `server` or `client` from its dependencies | M |
| FR-EX-05 | Cycles among state, queries and exposed values are reported with the full path | M |
| FR-EX-06 | Emission renames scope roots to the identifiers the page compiler chose, by splicing spans. Bytes outside the renamed spans are unchanged | M |
| FR-EX-07 | Calls are limited to an allowlist of pure methods and globals. Assignment, `new`, `await`, `this` and function declarations are refused | M |
| FR-EX-08 | The API is batched over napi with JSON in and out, and states that offsets are UTF-16 | M |

### 3.4 Agent surface (Phase 0, spec 004, LLD-04)

| ID | Requirement | P |
| --- | --- | --- |
| FR-AG-01 | The plugin serves the blueprint over HTTP under `/@trivia/api/blueprint/`, with the envelope, error codes and caller guard of `docs/api.md` | M |
| FR-AG-02 | The MCP endpoint gains `trivia_blueprint_get`, `trivia_blueprint_patch`, `trivia_blueprint_preview`, `trivia_blueprint_eject` and `trivia_blueprint_backend` | M |
| FR-AG-03 | A patch is one entry of the shared undo history, under the caller's label. Undo restores every touched document byte for byte | M |
| FR-AG-04 | Results carry diagnostics and the next step as structured fields, not only as text | M |
| FR-AG-05 | A patch against a stale revision is refused with 409 `conflict`, and nothing is written | M |
| FR-AG-06 | An agent can preview a page and see it through `trivia_screenshot` | M |
| FR-AG-07 | Eject applies a plan through the same batch path as every edit, as one undo entry | M |

### 3.5 React code generation, Vite (Phase 1, spec 005, LLD-05)

| ID | Requirement | P |
| --- | --- | --- |
| FR-RC-01 | A page compiles to one TSX module. The same inputs give the same bytes | M |
| FR-RC-02 | Contract pages are produced by the existing Refine page generator, so a blueprint page and `refine/pages/plan` agree | M |
| FR-RC-03 | Custom pages compile nodes to JSX, state to `useState`, queries and mutations to Refine hooks, and actions to handlers | M |
| FR-RC-04 | Imports are derived from what the module references, with component paths taken from `components.json` | M |
| FR-RC-05 | Emitted code re-parses without diagnostics and passes `tsc` in the target project | M |
| FR-RC-06 | A preview is the compiled module served at `/@trivia/preview/<id>.tsx`. Eject writes the same bytes | M |
| FR-RC-07 | Eject is a plan of Ops: a file per page, plus the resource entry and routes, registered the way the new-resource tool does | M |
| FR-RC-08 | The lock records the hash of every ejected file. Ejecting again is allowed when the file is missing or still has that hash, and refused with 409 `conflict` otherwise | M |
| FR-RC-09 | A new engine op, `replaceFile`, replaces a whole file guarded by the hash of its expected content | M |
| FR-RC-10 | A plan that needs a component the project lacks is refused with 422 and lists the registry items to add | M |
| FR-RC-11 | New files follow the project's semicolon and quote style | S |
| FR-RC-12 | A CLI, `trivia-blueprint`, validates and compiles without a dev server, and creates a new app from the `vite-refine` template | M |

### 3.6 Component kit (Phase 1, spec 006, LLD-06)

| ID | Requirement | P |
| --- | --- | --- |
| FR-KT-01 | The kit ships manifests for 25 shadcn components and the HTML elements listed in LLD-06 | M |
| FR-KT-02 | `DataTable` is a composite over refine-ui's data table and TanStack Table. Its columns come from contract fields, written as the columns tool writes them | M |
| FR-KT-03 | `Form` is a composite over react-hook-form and zod, in the project's form style (`Field` or `FormField`) | M |
| FR-KT-04 | Tables page, sort and filter on the server through Refine's `useTable` | M |
| FR-KT-05 | A table can virtualize its rows with TanStack Virtual | S |
| FR-KT-06 | A kit fixture blueprint uses every kit component. Its compiled output type-checks and renders in an e2e run | M |
| FR-KT-07 | A deferred component (tree, cascader, transfer, upload, time picker) is `unknown_component` with a hint that says so | M |

### 3.7 Designer Blueprint panel (Phase 1 and 2, spec 007, LLD-07)

| ID | Requirement | P |
| --- | --- | --- |
| FR-DS-01 | A Blueprint tab lists pages with their status (draft, ejected, edited since eject) and diagnostics | M |
| FR-DS-02 | A page's name, route, kind, resource and contract-page options can be created and edited | M |
| FR-DS-03 | A custom page's nodes can be added from the manifests, removed, reordered, and given props and bindings | M |
| FR-DS-04 | Preview loads the compiled page in the canvas. Eject asks for confirmation, showing the files and the registry items needed | M |
| FR-DS-05 | The model's entities, fields and relations can be edited (Phase 2) | M |
| FR-DS-06 | Generate backend shows the file plan before it writes (Phase 2) | M |
| FR-DS-07 | Every write goes through the patch API and the shared undo history | M |
| FR-DS-08 | The feature obeys the designer's layering rules (`architecture.test.ts`) | M |
| FR-DS-09 | Clicking an element of a preview selects its blueprint node | C |

### 3.8 Data model DSL (Phase 2, spec 008, LLD-08)

| ID | Requirement | P |
| --- | --- | --- |
| FR-DM-01 | The model document declares enums and entities: key, ordered fields, relations, indexes and API options | M |
| FR-DM-02 | Field types are `string`, `text`, `int`, `long`, `decimal`, `bool`, `date`, `datetime`, `uuid`, `enum` and `json`, with the constraints of LLD-08 | M |
| FR-DM-03 | Validation refuses duplicate and reserved names (C# and SQL), dangling relations, and defaults that do not fit the type | M |
| FR-DM-04 | One mapping table gives each type its C#, PostgreSQL, OpenAPI and zod form. It is the only place the mapping lives, and it is tested | M |
| FR-DM-05 | Relations are `belongsTo` and `hasMany`. Many-to-many needs an explicit join entity | M |
| FR-DM-06 | Each entity states its operations, its filterable, sortable and searchable fields, and its custom operations | M |
| FR-DM-07 | The model changes through BlueprintOps, like pages | M |
| FR-DM-08 | A field or entity can carry `renamedFrom`, which the generator turns into a rename, not a drop and an add | S |

### 3.9 .NET code generation (Phase 2, spec 009, LLD-09)

| ID | Requirement | P |
| --- | --- | --- |
| FR-NC-01 | A .NET tool, `trivia-dotnet`, has `plan` (print the file plan as JSON), `write` and `check` | M |
| FR-NC-02 | Generated files (`*.g.cs`) are overwritten on every run. Scaffold files are created when missing and never changed | M |
| FR-NC-03 | A generated file that was edited by hand is detected by its hash header, and the run is refused unless forced | M |
| FR-NC-04 | Entities, enums and a `DbContext` are emitted for EF Core 10 on PostgreSQL | M |
| FR-NC-05 | Request and response records are emitted, with validation from the model's constraints | M |
| FR-NC-06 | Each entity gets a minimal API endpoint group with the operations it enables | M |
| FR-NC-07 | List endpoints take `page`, `pageSize`, `sort`, `filter` and `q`, and answer `{ items, total, page, pageSize }` | M |
| FR-NC-08 | Partial methods give hooks before and after each write. Custom operations are routed by generated code and implemented in a scaffold file | M |
| FR-NC-09 | The API serves and builds an OpenAPI 3.1 document with stable operation ids, tags and schema names | M |
| FR-NC-10 | Errors are RFC 9457 problem details: 400 for validation, 404, 409 for a unique or concurrency conflict | M |
| FR-NC-11 | Output is deterministic, and the emitted solution builds with warnings as errors | M |
| FR-NC-12 | The tool can add an EF Core migration. It never edits an existing migration | M |
| FR-NC-13 | The API can require OIDC bearer tokens | S |

### 3.10 Aspire solution and contract loop (Phase 2, spec 010, LLD-10)

| ID | Requirement | P |
| --- | --- | --- |
| FR-AS-01 | The AppHost declares PostgreSQL, a migration service, the API and the web app, with their references and start order | M |
| FR-AS-02 | One command starts the whole solution with the Aspire dashboard | M |
| FR-AS-03 | A ServiceDefaults project adds OpenTelemetry, health checks, service discovery and resilience | M |
| FR-AS-04 | Building the API writes its OpenAPI document to `web/openapi/api.openapi.json` | M |
| FR-AS-05 | `pnpm sync` in `web/` regenerates the typed client and `trivia.manifest.json` from that document | M |
| FR-AS-06 | The web app has a Refine data provider for the API's conventions, as a scaffold file | M |
| FR-AS-07 | In development the web app reaches the API through a same-origin `/api` proxy resolved from Aspire's service discovery | M |
| FR-AS-08 | After a model change: regenerate, build, sync. Contract drift then lists each page's fixes | M |
| FR-AS-09 | The solution publishes to Docker Compose | S |

### 3.11 MVP slice (Phase 2, spec 011)

| ID | Requirement | P |
| --- | --- | --- |
| FR-MVP-01 | From an empty folder and one blueprint, the tool produces a solution that builds, type-checks, migrates and runs | M |
| FR-MVP-02 | The app has a table page with filters, a create and an edit form, a show page and two custom actions | M |
| FR-MVP-03 | The ejected app is edited through Trivia (a column, a form field, a prop) with byte-exact undo | M |
| FR-MVP-04 | An agent builds the same app over MCP from a short prompt | M |

### 3.12 Next.js target (Phase 3, spec 012, LLD-12)

| ID | Requirement | P |
| --- | --- | --- |
| FR-NX-01 | A second target, `next-refine`, emits App Router files (`app/**/page.tsx`, layouts, client components) | M |
| FR-NX-02 | Tiers decide the split: a `"use client"` boundary wraps the smallest subtree that needs the client | M |
| FR-NX-03 | Queries of tier `server` are fetched in the server component and passed as initial data | M |
| FR-NX-04 | The browser reaches the API through Next.js rewrites under `/api`. Server-side calls forward the user's credentials | M |
| FR-NX-05 | Nothing is cached unless the blueprint marks a page public and static | M |
| FR-NX-06 | A `next-refine` template exists, and the AppHost runs it as a JavaScript app | M |
| FR-NX-07 | One blueprint compiles for both targets without change | M |
| FR-NX-08 | The emitted app passes `tsc` and `next build` | M |

### 3.13 Trivia on Next.js (Phase 3, spec 013, LLD-13)

| ID | Requirement | P |
| --- | --- | --- |
| FR-TN-01 | Under `next dev`, every JSX opening tag is stamped with its locator, by the same Rust algorithm, with Turbopack and with webpack | M |
| FR-TN-02 | The engine API and MCP endpoint are served by a framework-neutral dev service that runs beside the Next.js dev server | M |
| FR-TN-03 | The designer's proxy sends API and MCP paths to the dev service and everything else, including the HMR socket, to Next.js | M |
| FR-TN-04 | The Pages tab lists App Router routes read from the `app/` directory | M |
| FR-TN-05 | Server and client components can both be selected and edited. After an edit the canvas refreshes and the selection re-resolves | M |
| FR-TN-06 | Nothing is stamped or served in `next build` or in production | M |
| FR-TN-07 | The Vite plugin's behaviour and contracts do not change | M |

## 4. External interfaces

- **HTTP:** `/@trivia/api/blueprint/*` (LLD-04), added to `docs/api.md`.
- **MCP:** five tools on `/@trivia/mcp` (LLD-04), added to `docs/mcp.md`.
- **CLI:** `trivia-blueprint` (Node) and `trivia-dotnet` (.NET tool). Exit code 0 on success, 1
  on diagnostics, 2 on a refused write.
- **Files:** blueprint documents and the lock (LLD-01, LLD-05); JSON Schemas published under
  `https://trivia.dev/schemas/blueprint/`; `web/openapi/api.openapi.json`; `trivia.manifest.json`.
- **Engine:** one new op (`replaceFile`), new napi functions for expressions (LLD-03).
- **Generated API:** the conventions of LLD-09 section 4, which the data provider relies on.

## 5. Non-functional requirements

| ID | Requirement |
| --- | --- |
| NFR-01 | **Byte preservation.** Any change to an existing source file is a span splice by the engine. Bytes outside the edited ranges are identical (`CLAUDE.md` rule 1) |
| NFR-02 | **Determinism.** Blueprint serialization, TSX emission and C# emission are pure functions of their inputs. No timestamps, random ids or machine paths appear in output |
| NFR-03 | **One semantics.** No interpreter of blueprints exists. Everything a user sees running is compiled code |
| NFR-04 | **Performance targets.** Validate a 200-page blueprint in under 1 s; compile one page in under 200 ms; analyze 1 000 expressions in under 50 ms; plan a 50-entity backend in under 5 s. Measured in CI on the reference machine |
| NFR-05 | **Security.** The API answers this machine only. Blueprint expressions are never evaluated by the tool. Every path is contained in the project root. Child processes are started with argument arrays, never through a shell. Generated APIs validate input and never return stack traces |
| NFR-06 | **Local first.** Validate and compile work offline. No telemetry |
| NFR-07 | **Clean room.** No Openblocks or Lowcoder source is read, translated or placed in an agent's context. All code is MIT |
| NFR-08 | **Compatibility.** Node 22.16+, React 19, TypeScript 6, Tailwind v4, shadcn with Radix or Base UI, .NET 10, Aspire 13.x, Next.js 16.x. Exact versions are pinned when a phase starts |
| NFR-09 | **Testability.** Every requirement has an automated test named after it. `pnpm check`, `pnpm e2e` and `dotnet test` are the gates |
| NFR-10 | **No proprietary runtime.** Emitted apps import nothing from `@trivia/*` at run time |
| NFR-11 | **Diff locality.** One logical change touches the fewest lines the format allows |
| NFR-12 | **Atomicity.** A failed operation writes nothing. Error codes are stable and documented |
| NFR-13 | **Accessibility.** Generated forms label every control, and kit components keep their library's keyboard and ARIA behaviour |
| NFR-14 | **Documentation.** A new endpoint, tool or op ships with its `docs/` entry and an example the tests pin |

## 6. Verification

- Unit tests beside the code; fixture round trips for serialization and emission.
- Golden files for emitted TSX and C#, plus `tsc` and `dotnet build -warnaserror` on them.
- Plugin tests against a copy of the example app, as the Refine suites do.
- Playwright e2e for the designer panel, preview, eject and undo.
- An integration test that starts the generated AppHost and exercises the API.
- The MVP slice (spec 011) is the acceptance test for Phases 0 to 2.

## 7. Traceability

| Business requirement | Requirements | Spec |
| --- | --- | --- |
| BR-01 | FR-BP-01 to FR-BP-09, NFR-02, NFR-11 | 001 |
| BR-02 | FR-MF-01 to FR-MF-07, FR-KT-01 | 002, 006 |
| BR-03 | FR-EX-01 to FR-EX-08 | 003 |
| BR-04 | FR-AG-01 to FR-AG-07, FR-DS-01 to FR-DS-08 | 004, 007 |
| BR-05 | FR-RC-01 to FR-RC-05, FR-RC-10 to FR-RC-12, FR-KT-02 to FR-KT-07, NFR-10 | 005, 006 |
| BR-06 | FR-RC-06, FR-AG-06, FR-DS-04, NFR-03 | 005, 004, 007 |
| BR-07 | FR-RC-07 to FR-RC-09, FR-MVP-03, NFR-01 | 005, 011 |
| BR-08 | FR-DM-01 to FR-DM-08, FR-NC-01 to FR-NC-12 | 008, 009 |
| BR-09 | FR-AS-01 to FR-AS-08, FR-MVP-01, FR-MVP-02, FR-MVP-04 | 010, 011 |
| BR-10 | FR-NX-01 to FR-NX-08 | 012 |
| BR-11 | FR-TN-01 to FR-TN-07 | 013 |
| BR-12 | NFR-07 | constitution, ADR-0001 |
| BR-13 | none (Phase 4 is gated) | ADR-0014 |
| BR-14 | FR-NC-13 | 009 |
| BR-15 | FR-BP-10 | 001 |
