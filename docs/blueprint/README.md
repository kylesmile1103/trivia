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

## MVP acceptance measurements

Run `pnpm exec nx run tools:mvp` for the scripted slice. Real releases run this target
before tagging and require the .NET 10 SDK and a running container runtime.

Measurements on the Apple silicon reference machine used warm dependency and PostgreSQL
image caches.

- **SC-004.** Adding `segment` after declaring its enum adds **five blueprint lines**.
  The full backend regeneration changes **six `.g.cs` files** and one EF migration,
  including its designer file and the existing model snapshot.
- **SC-005.** The browser rendered the customers list in **42.3 seconds** from an empty
  temporary directory. The measurement includes scaffolding, dependency restore,
  backend generation, contract sync, eject, startup and the first list render.
  It starts after Chromium launches and ends when the Status column appears.

See the fixture, setup and exact authoring prompt. [BankAdmin example](../../examples/blueprint-mvp/README.md).

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
| 011 | MVP slice: a CRUD admin end to end | 2 | [LLD-11](lld/LLD-11-mvp-crud-admin.md) | [spec](../../specs/011-mvp-crud-admin/spec.md) | FR-MVP |
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
| Day 1 joins the product for this track | ADR-0002, BRD section 8 | The blueprint track now covers the initial .NET and React scaffold |

BRD section 10 lists four open questions with the defaults taken.

## Spec 001–011 decisions pending review

The lead reviews these decisions with the owner.

- Spec 001. Node, state and query names share a page namespace and use JavaScript identifiers that avoid reserved words. [LLD-01](lld/LLD-01-blueprint-schema.md#page)
- Spec 001. Action keys pair the node ID with an event prop in the form `<nodeId>.on<Event>`. [LLD-01](lld/LLD-01-blueprint-schema.md#page)
- Spec 001. A contract action's `confirm` is the confirmation text. [LLD-01](lld/LLD-01-blueprint-schema.md#page)
- Spec 001. `toast.variant` is `default`, `success`, `info`, `warning` or `error`. [LLD-01](lld/LLD-01-blueprint-schema.md#page)
- Spec 001. `styles[id]` holds `className` only (ADR-0016). [LLD-01](lld/LLD-01-blueprint-schema.md#page)
- Spec 001. The original store validated the model envelope and preserved the order of the other properties. Spec 008 added full model validation. [LLD-01](lld/LLD-01-blueprint-schema.md#page)
- Spec 001. The keys of free JSON (static prop values, `initial`) sort bytewise too, so equal values are equal bytes. [LLD-01](lld/LLD-01-blueprint-schema.md#3-canonical-serialization-fr-bp-04)
- Spec 001. A loaded revision hashes the original bytes, including key order. [LLD-01](lld/LLD-01-blueprint-schema.md#3-canonical-serialization-fr-bp-04)
- Spec 001. `baseRev: null` means the document must not exist yet (`createPage`, `setApp` on a new blueprint). [LLD-01](lld/LLD-01-blueprint-schema.md#4-blueprintops-fr-bp-07)
- Spec 001. An `addNode` operation guards the parent with `expectedType`. [LLD-01](lld/LLD-01-blueprint-schema.md#4-blueprintops-fr-bp-07)
- Spec 001. `createPage` of kind `custom` also creates the root, a `div` named `page` (`rootType` changes the type), so every later node has a parent. [LLD-01](lld/LLD-01-blueprint-schema.md#4-blueprintops-fr-bp-07)
- Spec 001. A page rename moves its file and requires updated navigation in the same batch. [LLD-01](lld/LLD-01-blueprint-schema.md#4-blueprintops-fr-bp-07)
- Spec 001. Setting a static prop removes its binding, and setting a binding removes its static value. [LLD-01](lld/LLD-01-blueprint-schema.md#4-blueprintops-fr-bp-07)
- Spec 001. A node rename requires expression tools when a binding refers to the old name and returns the relevant pointers on refusal. [LLD-01](lld/LLD-01-blueprint-schema.md#4-blueprintops-fr-bp-07)
- Spec 001. `created` keys are `<Page>` for a page and `<Page>/<node>` for a node (and `<Page>/page` for a root), so two pages in one batch cannot collide. [LLD-01](lld/LLD-01-blueprint-schema.md#4-blueprintops-fr-bp-07)
- Spec 001. A batch is blocked by errors it introduces, compared by code, document and pointer. [LLD-01](lld/LLD-01-blueprint-schema.md#4-blueprintops-fr-bp-07)
- Spec 001. Validation accepts injected check functions for manifests, contract and expressions. [LLD-01](lld/LLD-01-blueprint-schema.md#5-validation-fr-bp-05)
- Spec 001. `schema_violation` rejects `__proto__` before zod parsing. [LLD-01](lld/LLD-01-blueprint-schema.md#5-validation-fr-bp-05)
- Spec 001. `dangling_reference` covers unresolved state and query names in action steps. [LLD-01](lld/LLD-01-blueprint-schema.md#5-validation-fr-bp-05)
- Spec 001. `invalid_root` identifies a second parentless node or an invalid root parent or slot. [LLD-01](lld/LLD-01-blueprint-schema.md#5-validation-fr-bp-05)
- Spec 001. `missing_slot` identifies a child with a null slot. Manifest validation checks the slot name. [LLD-01](lld/LLD-01-blueprint-schema.md#5-validation-fr-bp-05)
- Spec 001. `duplicate_prop` points to the bound prop. [LLD-01](lld/LLD-01-blueprint-schema.md#5-validation-fr-bp-05)
- Spec 001. `duplicate_order` warns on the later sibling and uses node ID to break ties. [LLD-01](lld/LLD-01-blueprint-schema.md#5-validation-fr-bp-05)
- Spec 001. `file_name_mismatch` points to the page name when it disagrees with the filename. [LLD-01](lld/LLD-01-blueprint-schema.md#5-validation-fr-bp-05)
- Spec 001. The duplicate-prop fix removes the static value and preserves the binding. [LLD-01](lld/LLD-01-blueprint-schema.md#5-validation-fr-bp-05)
- Spec 001. Version steps are registered in the `MIGRATIONS[kind][N]` table. [LLD-01](lld/LLD-01-blueprint-schema.md#6-migrations-fr-bp-06)
- Spec 001. Loading a migrated document preserves its original bytes and revision until a batch edits it. [LLD-01](lld/LLD-01-blueprint-schema.md#6-migrations-fr-bp-06)
- Spec 001. Repeated inserts can extend fractional index keys indefinitely. [LLD-01](lld/LLD-01-blueprint-schema.md#10-open-points)
- Spec 001. `state` types stay free TypeScript, because `tsc` checks the emitted code (LLD-05). [LLD-01](lld/LLD-01-blueprint-schema.md#10-open-points)
- Spec 001. The build emits committed, exported JSON Schemas and tests their agreement with zod. [LLD-01](lld/LLD-01-blueprint-schema.md#11-json-schemas-fr-mf-07s-base-sc-005)
- Spec 002. Style variants are an optional `variants` object keyed by the style in `components.json`. [LLD-02](lld/LLD-02-component-manifests.md#2-shape)
- Spec 002. Kit manifests can declare static-only `configuration` alongside the native props. [LLD-02](lld/LLD-02-component-manifests.md#2-shape)
- Spec 002. `from: "refine-ui"` resolves the installed Refine table export using the project's component aliases (LLD-06). [LLD-02](lld/LLD-02-component-manifests.md#2-shape)
- Spec 002. The caller supplies `ui` and `components` from the aliases and `style` from the same file. [LLD-02](lld/LLD-02-component-manifests.md#3-resolution-fr-mf-02-to-fr-mf-06)
- Spec 002. When several files export that name, use the exact module specifier if it selects one candidate. [LLD-02](lld/LLD-02-component-manifests.md#3-resolution-fr-mf-02-to-fr-mf-06)
- Spec 002. When a `from: "ui"` export resolves uniquely, the import uses the installed filename under the project's UI alias, including when the file was renamed (LLD-06). [LLD-02](lld/LLD-02-component-manifests.md#3-resolution-fr-mf-02-to-fr-mf-06)
- Spec 002. Descriptions of recognized props are in `propDescriptions`, keeping the analyzer list verbatim. [LLD-02](lld/LLD-02-component-manifests.md#3-resolution-fr-mf-02-to-fr-mf-06)
- Spec 002. A missing entry keeps its declared props for discovery until the analyzer finds it. [LLD-02](lld/LLD-02-component-manifests.md#3-resolution-fr-mf-02-to-fr-mf-06)
- Spec 002. Non-void tags accept node children and a string `children` prop. [LLD-02](lld/LLD-02-component-manifests.md#3-resolution-fr-mf-02-to-fr-mf-06)
- Spec 002. Lowercase names are reserved for the curated HTML entries and cannot be overridden. [LLD-02](lld/LLD-02-component-manifests.md#3-resolution-fr-mf-02-to-fr-mf-06)
- Spec 002. A missing slot gets `unknown_slot`. Incompatible content gets the slot-content diagnostic. [LLD-02](lld/LLD-02-component-manifests.md#4-what-validation-checks-against-a-manifest)
- Spec 002. Text children require strings. Analyzer props of kind `unknown` accept any JSON value. [LLD-02](lld/LLD-02-component-manifests.md#4-what-validation-checks-against-a-manifest)
- Spec 002. The `controlled_change_binding` error points at the binding and suggests the matching action by its public event name. [LLD-02](lld/LLD-02-component-manifests.md#4-what-validation-checks-against-a-manifest)
- Spec 002. Kit events and exposed values can describe props that the analyzer skips, such as `onClick` from React's button props and `value` and `onChange` from its input props. [LLD-02](lld/LLD-02-component-manifests.md#4-what-validation-checks-against-a-manifest)
- Spec 002. `exposedScope(page, manifests)` produces the client `ui` root described in LLD-03. [LLD-02](lld/LLD-02-component-manifests.md#4-what-validation-checks-against-a-manifest)
- Spec 002. The response fields are `schemas` (draft 2020-12, keyed by type) and `index` (an array). [LLD-02](lld/LLD-02-component-manifests.md#5-json-schema-for-agents-fr-mf-07-should)
- Spec 003. The operator allowlist covers arithmetic, relational and equality symbols, and the listed logical and unary operators. [LLD-03](lld/LLD-03-expression-compiler.md#1-the-language)
- Spec 003. Callbacks are synchronous expression-bodied arrows supplied directly as call arguments. [LLD-03](lld/LLD-03-expression-compiler.md#1-the-language)
- Spec 003. The Math allowlist enumerates deterministic functions and restricts computed call targets. [LLD-03](lld/LLD-03-expression-compiler.md#1-the-language)
- Spec 003. Known member shapes accept arrays of names, nested objects, and `null` for an open shape. [LLD-03](lld/LLD-03-expression-compiler.md#2-scope)
- Spec 003. Page-wide and per-expression `locals` accept a name array (all `client`) or a name-to-tier object. [LLD-03](lld/LLD-03-expression-compiler.md#2-scope)
- Spec 003. `expr_shadowed_root` is a warning on the parameter name, including names in destructuring patterns. [LLD-03](lld/LLD-03-expression-compiler.md#2-scope)
- Spec 003. Direct built-in member reads are limited to the allowlist and the Math and Number constants. [LLD-03](lld/LLD-03-expression-compiler.md#2-scope)
- Spec 003. A bare root or a computed root member with no literal name records `root.*`. [LLD-03](lld/LLD-03-expression-compiler.md#3-analysis)
- Spec 003. A query with no valid parameter expressions starts at the static tier. Tier increases propagate through dependencies. [LLD-03](lld/LLD-03-expression-compiler.md#3-analysis)
- Spec 003. Overlapping cycles produce one diagnostic per participating expression. [LLD-03](lld/LLD-03-expression-compiler.md#3-analysis)
- Spec 003. `expressionCheck(analyzeExpressions, page => exposedScope(page, manifests))` plugs into `ValidationContext.expressions`. [LLD-03](lld/LLD-03-expression-compiler.md#blueprint-validation)
- Spec 003. The page adapter gets `params` from the route and checks query result field names by kind (LLD-05). [LLD-03](lld/LLD-03-expression-compiler.md#blueprint-validation)
- Spec 003. A repeat alias and `index` inherit the tier of `each` throughout the subtree. [LLD-03](lld/LLD-03-expression-compiler.md#blueprint-validation)
- Spec 003. Emission enforces the syntax and call subset and uses the caller's name map without checking it against a page scope. [LLD-03](lld/LLD-03-expression-compiler.md#4-emission-fr-ex-06)
- Spec 003. Identity prefixes keep their original bytes and suppress shorter replacements. [LLD-03](lld/LLD-03-expression-compiler.md#4-emission-fr-ex-06)
- Spec 003. Reference renaming edits only the property name of a free `ui` access, preserving optional chaining, comments and string delimiters. [LLD-03](lld/LLD-03-expression-compiler.md#4-emission-fr-ex-06)
- Spec 003. Pass `{ expressions: { renameReferences } }` to the store or reducer. [LLD-03](lld/LLD-03-expression-compiler.md#4-emission-fr-ex-06)
- Spec 003. Emit accepts a batch-wide `arrowBody` flag. [LLD-03](lld/LLD-03-expression-compiler.md#4-emission-fr-ex-06)
- Spec 003. A raw scan limits OXC input to 64 opening brackets and 12 standalone opening angle brackets, counting strings and comments too. [LLD-03](lld/LLD-03-expression-compiler.md#6-limits)
- Spec 003. OXC 0.153.0's `Parser::parse_expression` consumes through EOF and already gives source-relative spans. [LLD-03](lld/LLD-03-expression-compiler.md#6-limits)
- Spec 003. The depth walk counts expressions, statement and type nodes, patterns, and nested JSX. [LLD-03](lld/LLD-03-expression-compiler.md#6-limits)
- Spec 004. Spec 013 moved the HTTP API, MCP endpoint and Refine adapter into `packages/dev-service`. [LLD-04](lld/LLD-04-agent-surface.md#1-the-adapter)
- Spec 004. The native `restoreFiles` preflights through `Workspace::exists`, which only accepts `.tsx` and `.jsx`, and reparses replacement source through `Workspace::restore`. [LLD-04](lld/LLD-04-agent-surface.md#1-the-adapter)
- Spec 004. Writes replace by rename and create by linking staged bytes into the destination. [LLD-04](lld/LLD-04-agent-surface.md#1-the-adapter)
- Spec 004. History labels identify patch entries. A no-op returns a null entry. [LLD-04](lld/LLD-04-agent-surface.md#1-the-adapter)
- Spec 004. Vite's `blueprintDir` option resolves to a child directory of the project root, default `blueprint`. [LLD-04](lld/LLD-04-agent-surface.md#1-the-adapter)
- Spec 004. Use the blueprint package's pure loader and reducer with checked reads in the service store. [LLD-04](lld/LLD-04-agent-surface.md#1-the-adapter)
- Spec 004. A malformed lock yields an `invalid_lock` warning and draft statuses. [LLD-04](lld/LLD-04-agent-surface.md#2-http-fr-ag-01)
- Spec 004. The model summary lists entity names in document order with the revision of the file on disk. [LLD-04](lld/LLD-04-agent-surface.md#2-http-fr-ag-01)
- Spec 004. The starter hint and published `setApp` schema call out the web target required on creation. [LLD-04](lld/LLD-04-agent-surface.md#2-http-fr-ag-01)
- Spec 004. Patch plans, derives the summary from the result snapshot, and commits while holding the shared queue. [LLD-04](lld/LLD-04-agent-surface.md#2-http-fr-ag-01)
- Spec 004. `trivia_undo` checks its expected label in the shared queue, alongside the actual undo, so a queued edit cannot change which entry is undone. [LLD-04](lld/LLD-04-agent-surface.md#3-mcp-fr-ag-02)
- Spec 004. Blueprint tool refusals carry `structuredContent.error` and tool-specific `next` advice alongside the MCP error text so agents can recover using the machine-readable revisions. [LLD-04](lld/LLD-04-agent-surface.md#3-mcp-fr-ag-02)
- Spec 004. The preview and eject routes and tools validate their request shape and return `unsupported` until spec 005. [LLD-04](lld/LLD-04-agent-surface.md#3-mcp-fr-ag-02)
- Spec 004. MCP hints list synced operation names and point mistyped list-header refetches to the implicit `list` query. [LLD-04](lld/LLD-04-agent-surface.md#4-errors)
- Spec 004. Blueprint routes and tools require loopback even when Vite enables `allowRemote` for the existing source API. [LLD-04](lld/LLD-04-agent-surface.md#5-security)
- Spec 004. The backend bridge invokes the installed `trivia-dotnet` shim with an argument array, the dev host project root as the solution root and working directory, and a timeout. [LLD-04](lld/LLD-04-agent-surface.md#5-security)
- Spec 004. `mode: "write"` with a migration runs the CLI's separate `migrate` command after the caller generates the API. [LLD-04](lld/LLD-04-agent-surface.md#5-security)
- Spec 004. `e2e/blueprint-mcp.spec.ts` runs patch and byte-exact undo in a browser through the Vite and Next.js designer proxies. [LLD-04](lld/LLD-04-agent-surface.md#6-tests)
- Spec 005. Project facts infer quote and semicolon style from the majority of the entry file's static imports. [LLD-05](lld/LLD-05-react-codegen.md#1-pipeline)
- Spec 005. LLD-13 moved the Refine adapter and the blueprint HTTP and MCP surfaces to `packages/dev-service`. [LLD-05](lld/LLD-05-react-codegen.md#2-contract-pages-fr-rc-02)
- Spec 005. The same service injects `CompileContext.refineSnippets` for LLD-06. [LLD-05](lld/LLD-05-react-codegen.md#2-contract-pages-fr-rc-02)
- Spec 005. Explicit fields keep the blueprint's order, with exclusions taking precedence. [LLD-05](lld/LLD-05-react-codegen.md#2-contract-pages-fr-rc-02)
- Spec 005. A list header can use `{ "do": "refetch", "query": "list" }` to refetch the existing Refine table query with its current filters and pagination. [LLD-05](lld/LLD-05-react-codegen.md#2-contract-pages-fr-rc-02)
- Spec 005. Row handlers get the record and use browser confirmation. Header actions render below the Refine header. [LLD-05](lld/LLD-05-react-codegen.md#2-contract-pages-fr-rc-02)
- Spec 005. Custom list row buttons wrap inside the actions cell. Forms catch submit rejections after Refine records field errors. [LLD-05](lld/LLD-05-react-codegen.md#2-contract-pages-fr-rc-02)
- Spec 005. The compiler and the Refine adapter share the resource key derived from the collection path, so hooks and registered Refine routes name the same resource. [LLD-05](lld/LLD-05-react-codegen.md#2-contract-pages-fr-rc-02)
- Spec 005. Dependent queries follow topological order. [LLD-05](lld/LLD-05-react-codegen.md#3-custom-pages-the-ir-fr-rc-03)
- Spec 005. A static value prop seeds the exposed state. [LLD-05](lld/LLD-05-react-codegen.md#3-custom-pages-the-ir-fr-rc-03)
- Spec 005. The stub types the declared page state and setters and exposes the triggering event as unknown, since multiple event types can call one handler. [LLD-05](lld/LLD-05-react-codegen.md#3-custom-pages-the-ir-fr-rc-03)
- Spec 005. Wrapper parts follow manifest slot order. [LLD-05](lld/LLD-05-react-codegen.md#3-custom-pages-the-ir-fr-rc-03)
- Spec 005. Static JSX text and attributes escape entity syntax while preserving the rendered value. [LLD-05](lld/LLD-05-react-codegen.md#4-the-printer-fr-rc-01-fr-rc-11)
- Spec 005. The fixture app uses the banking mock API, contract and Refine UI from `examples/refine-admin`, and the installed Card from `examples/playground`. [LLD-05](lld/LLD-05-react-codegen.md#4-the-printer-fr-rc-01-fr-rc-11)
- Spec 005. Vite injects the development route beside the Refine app's existing routes. [LLD-05](lld/LLD-05-react-codegen.md#5-preview-fr-rc-06)
- Spec 005. The dev service uses the full shipped kit manifest catalog from spec 006. [LLD-05](lld/LLD-05-react-codegen.md#5-preview-fr-rc-06)
- Spec 005. Eject updates `meta.label` on a matching literal Refine resource and leaves any existing icon import in place. [LLD-05](lld/LLD-05-react-codegen.md#6-eject-fr-rc-07-to-fr-rc-10)
- Spec 005. Existing call handlers are kept, including one created after the plan was read. [LLD-05](lld/LLD-05-react-codegen.md#6-eject-fr-rc-07-to-fr-rc-10)
- Spec 005. The lock records the route and component as well as the hash. [LLD-05](lld/LLD-05-react-codegen.md#6-eject-fr-rc-07-to-fr-rc-10)
- Spec 005. The adapter appends the guarded lock write as the final op of the source batch. [LLD-05](lld/LLD-05-react-codegen.md#the-lock)
- Spec 005. A missing file returns `file_not_found`. A hash match is followed by parsing the source and checking the expected file. [LLD-05](lld/LLD-05-react-codegen.md#replacefile)
- Spec 005. The offline CLI loads the installed Vite adapter's dev service (or the sibling build in the repo) and constructs a standalone engine service without a server. [LLD-05](lld/LLD-05-react-codegen.md#7-cli-and-templates-fr-rc-12)
- Spec 005. The Vite template uses the application's `Plugin` type for the Trivia plugin at the config boundary. [LLD-05](lld/LLD-05-react-codegen.md#7-cli-and-templates-fr-rc-12)
- Spec 005. The Vite scaffold wires Refine's notification provider to Sonner 2.0.8, the version used by the Refine example. [LLD-05](lld/LLD-05-react-codegen.md#7-cli-and-templates-fr-rc-12)
- Spec 006. Exact style variants take precedence over a library-family variant such as `base`. [LLD-06](lld/LLD-06-component-kit.md#2-published-manifests-fr-kt-01)
- Spec 006. Manifest slots describe the outer registry parts. [LLD-06](lld/LLD-06-component-kit.md#2-published-manifests-fr-kt-01)
- Spec 006. The dev service reads the shipped kit manifests in place of the three spec 002 samples. [LLD-06](lld/LLD-06-component-kit.md#2-published-manifests-fr-kt-01)
- Spec 006. `configuration` describes compiler-consumed static props without changing the analyzer's native prop list. [LLD-06](lld/LLD-06-component-kit.md#2-published-manifests-fr-kt-01)
- Spec 006. Tabs accepts a static array of unique names and labels. [LLD-06](lld/LLD-06-component-kit.md#2-published-manifests-fr-kt-01)
- Spec 006. LLD-13 puts these builders in `packages/dev-service/src/refine/`. [LLD-06](lld/LLD-06-component-kit.md#3-datatable-fr-kt-02-fr-kt-04-fr-kt-05)
- Spec 006. The installed Refine DataTable takes the table object and manages its own body. [LLD-06](lld/LLD-06-component-kit.md#3-datatable-fr-kt-02-fr-kt-04-fr-kt-05)
- Spec 006. The table requires an explicit nonempty column list. [LLD-06](lld/LLD-06-component-kit.md#3-datatable-fr-kt-02-fr-kt-04-fr-kt-05)
- Spec 006. Selection uses a labelled radio or checkbox column and the contract primary key. [LLD-06](lld/LLD-06-component-kit.md#3-datatable-fr-kt-02-fr-kt-04-fr-kt-05)
- Spec 006. The existing Refine adapter chooses the prevailing form style and uses Field on a tie when both installs exist. [LLD-06](lld/LLD-06-component-kit.md#4-form-fr-kt-03)
- Spec 006. The dev service injects the published list into layer 3. [LLD-06](lld/LLD-06-component-kit.md#5-deferred-fr-kt-07)
- Spec 006. Actions and display share one fixture page. [LLD-06](lld/LLD-06-component-kit.md#6-the-kit-fixture-fr-kt-06)
- Spec 006. The Radix example uses shadcn CLI 4.21.3 with the `radix-nova` preset and a self-contained snapshot of the banking OpenAPI contract, provider, and mock. [LLD-06](lld/LLD-06-component-kit.md#6-the-kit-fixture-fr-kt-06)
- Spec 006. The second type-check uses the committed `base-nova` sources, Base UI 1.9.0, and the parent fixture's Refine table registry. [LLD-06](lld/LLD-06-component-kit.md#6-the-kit-fixture-fr-kt-06)
- Spec 006. The manifest checker locates exports through the engine's `components()` result and uses the installed TypeScript checker for inherited props and matching wrapper exports. [LLD-06](lld/LLD-06-component-kit.md#6-the-kit-fixture-fr-kt-06)
- Spec 006. The kit example registers the customer resource's list and create paths so Refine can redirect a successful create to the ejected table. [LLD-06](lld/LLD-06-component-kit.md#6-the-kit-fixture-fr-kt-06)
- Spec 006. Generated forms name their landmarks and associate invalid controls with inline errors. [LLD-06](lld/LLD-06-component-kit.md#6-the-kit-fixture-fr-kt-06)
- Spec 007. Compact tab controls use icons with accessible names and tooltips. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#1-place-in-the-designer)
- Spec 007. The blueprint handlers live in `packages/dev-service`, behind `DevHost` (LLD-13). [LLD-07](lld/LLD-07-designer-blueprint-panel.md#1-place-in-the-designer)
- Spec 007. Open resolves the registered route by the generated file when available. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. The reducer permits kind changes within contract kinds. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. Manifest slots determine which parents can accept a child, including empty containers. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. The blueprint panel may use plain inputs while shared widgets are moved. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. The enum widget is shared. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. The canvas derives the banner from the actual `/__blueprint/` path, so it follows navigation and replaces the missing-locators notice for these routes. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. The virtual custom preview module carries blueprint node IDs. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. Refine items link to their registry URL and local items use manual installation. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. The live DevHost plan includes the lock as the final op in that source transaction. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. A refused hasMany and its suggested belongsTo are applied together against the revision the editor read, after the user presses Apply fix. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. The table includes the DevHost's delete action. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. A successful patch asks the shared engine session to sync history immediately so the toolbar takes up its entry. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. Initialization uses `App` as the initial document name and selects the web target from the designer's existing health response (`next-refine` for Next, `vite-refine` for Vite). [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. A finding focuses the closest field matching its JSON pointer, opening its page first when needed. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#2-behaviour)
- Spec 007. A refresh waits for an in-flight patch, and only newer reads replace the open snapshot. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#3-state-and-concurrency)
- Spec 007. Playwright runs the worktree's packaged `trivia-dotnet` on PATH and checks the proposed source and solution are still absent after planning. [LLD-07](lld/LLD-07-designer-blueprint-panel.md#4-tests)
- Spec 008. The namespace is one or more dot-separated PascalCase identifiers. [LLD-08](lld/LLD-08-data-model-dsl.md#1-document)
- Spec 008. The mapping fixture is keyed by blueprint field type. [LLD-08](lld/LLD-08-data-model-dsl.md#2-types-and-mapping-fr-dm-02-fr-dm-04)
- Spec 008. Each field type has a strict schema, so a constraint on the wrong field type produces `schema_violation` at that property. [LLD-08](lld/LLD-08-data-model-dsl.md#2-types-and-mapping-fr-dm-02-fr-dm-04)
- Spec 008. An inverse matches the exact entity and foreign-key names, including in self-relations. [LLD-08](lld/LLD-08-data-model-dsl.md#3-relations-fr-dm-05)
- Spec 008. An unmatched relation's guarded `setRelation` hint uses the foreign key without its `Id` suffix or the lowercased source type as the inverse name. [LLD-08](lld/LLD-08-data-model-dsl.md#3-relations-fr-dm-05)
- Spec 008. `setModel` initializes empty entities and enums. `setEntity` merges supported properties. [LLD-08](lld/LLD-08-data-model-dsl.md#4-ops-fr-dm-07-fr-dm-08)
- Spec 008. An entity rename also updates custom operation returns and can be paired with `setEntity` to change the plural. [LLD-08](lld/LLD-08-data-model-dsl.md#4-ops-fr-dm-07-fr-dm-08)
- Spec 008. Entity and enum removals report the blocking references in the draft. [LLD-08](lld/LLD-08-data-model-dsl.md#4-ops-fr-dm-07-fr-dm-08)
- Spec 008. The public model API exposes the full schema and `validateModel(value, baseRev)`. [LLD-08](lld/LLD-08-data-model-dsl.md#4-ops-fr-dm-07-fr-dm-08)
- Spec 008. The development service supplies the last generated model revision and field summary from the lock. [LLD-08](lld/LLD-08-data-model-dsl.md#5-validation-fr-dm-03)
- Spec 008. The reserved word lists have a `source` and `date` header in each JSON object, followed by `words`. [LLD-08](lld/LLD-08-data-model-dsl.md#5-validation-fr-dm-03)
- Spec 008. Enums and entities share a case-insensitive type namespace. [LLD-08](lld/LLD-08-data-model-dsl.md#5-validation-fr-dm-03)
- Spec 008. Reserved checks fold identifier case and compare SQL names in their emitted snake_case. [LLD-08](lld/LLD-08-data-model-dsl.md#5-validation-fr-dm-03)
- Spec 008. Explicit null defaults require a nullable field. [LLD-08](lld/LLD-08-data-model-dsl.md#5-validation-fr-dm-03)
- Spec 008. Filters and sorts accept scalar fields, and searches accept `string` and `text`. [LLD-08](lld/LLD-08-data-model-dsl.md#5-validation-fr-dm-03)
- Spec 008. The shared schema emitter writes the model's draft 2020-12 input schema to `packages/blueprint/schemas/model.v1.json`, beside the app and page schemas. [LLD-08](lld/LLD-08-data-model-dsl.md#7-tests)
- Spec 009. Embed the two published schemas in the tool and evaluate them locally with JsonSchema.Net. [LLD-09](lld/LLD-09-dotnet-codegen.md#1-the-tool)
- Spec 009. All three generation commands report the same JSON envelope on stdout, including diagnostics on failure. [LLD-09](lld/LLD-09-dotnet-codegen.md#1-the-tool)
- Spec 009. Plan paths use forward-slash relative names. [LLD-09](lld/LLD-09-dotnet-codegen.md#2-ownership-fr-nc-02-fr-nc-03)
- Spec 009. Discover obsolete files under the API's generated directories via the tool's header marker. [LLD-09](lld/LLD-09-dotnet-codegen.md#2-ownership-fr-nc-02-fr-nc-03)
- Spec 009. The standalone `Program.cs` calls `AddGeneratedServices` and `MapGeneratedEndpoints`. [LLD-09](lld/LLD-09-dotnet-codegen.md#3-output)
- Spec 009. OpenAPI keeps framework component IDs and uses transformers for enum values, JSON types, input metadata and paging bounds. [LLD-09](lld/LLD-09-dotnet-codegen.md#4-api-conventions-fr-nc-06-fr-nc-07-fr-nc-10)
- Spec 009. The enum schema transformer unwraps `Nullable<T>` before looking up wire values. [LLD-09](lld/LLD-09-dotnet-codegen.md#4-api-conventions-fr-nc-06-fr-nc-07-fr-nc-10)
- Spec 009. Always order by the key as the final sort term for stable page boundaries. [LLD-09](lld/LLD-09-dotnet-codegen.md#4-api-conventions-fr-nc-06-fr-nc-07-fr-nc-10)
- Spec 009. Each entity uses a feature namespace under the model namespace. [LLD-09](lld/LLD-09-dotnet-codegen.md#5-emitters)
- Spec 009. Enum member names derive from ASCII words in the literal, with a prefix for empty or numeric names and numeric suffixes for collisions. [LLD-09](lld/LLD-09-dotnet-codegen.md#5-emitters)
- Spec 009. UUID keys are created with `Guid.CreateVersion7()` in the entity. [LLD-09](lld/LLD-09-dotnet-codegen.md#5-emitters)
- Spec 009. Request properties are nullable at deserialization so validation can distinguish missing values from zero or false. [LLD-09](lld/LLD-09-dotnet-codegen.md#5-emitters)
- Spec 009. Validate decimal precision and scale at the request boundary so storage cannot silently round or overflow a value that passed request validation. [LLD-09](lld/LLD-09-dotnet-codegen.md#5-emitters)
- Spec 009. Include `OnDeleted` to give deletion both hooks under FR-NC-08. [LLD-09](lld/LLD-09-dotnet-codegen.md#5-emitters)
- Spec 009. Put each custom partial declaration in its own `.g.cs` sibling so the project can exclude retired scaffold code from compilation while retaining its bytes. [LLD-09](lld/LLD-09-dotnet-codegen.md#5-emitters)
- Spec 009. Reserve the wire member `version` on entities with concurrency enabled. [LLD-09](lld/LLD-09-dotnet-codegen.md#5-emitters)
- Spec 009. `migrate` uses an installed `dotnet ef` and fixes the destination to `Data/Migrations`. [LLD-09](lld/LLD-09-dotnet-codegen.md#6-migrations-fr-nc-12)
- Spec 009. Resolve an old table's actual plural from EF's preceding model snapshot. [LLD-09](lld/LLD-09-dotnet-codegen.md#6-migrations-fr-nc-12)
- Spec 009. Protect the runtime OpenAPI endpoint as well as the model groups in OIDC mode. [LLD-09](lld/LLD-09-dotnet-codegen.md#7-auth-fr-nc-13-should)
- Spec 009. The Nx `dotnet` build and test targets run without caching. [LLD-09](lld/LLD-09-dotnet-codegen.md#8-tests)
- Spec 010. Pin the C# AppHost SDK, `Aspire.Hosting.AppHost`, `Aspire.Hosting.PostgreSQL`, `Aspire.Hosting.JavaScript`, `Aspire.Hosting.Docker` and `Aspire.Hosting.Testing` to **13.6.5**. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#verified-dependencies)
- Spec 010. Keep the existing .NET 10.0.12 pins for `Microsoft.AspNetCore.OpenApi` and `Microsoft.Extensions.ApiDescription.Server`. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#verified-dependencies)
- Spec 010. Use the Aspire CLI bundle for DCP and the dashboard. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#1-the-solution)
- Spec 010. Pin `Microsoft.Extensions.Hosting` to **10.0.14**, resilience and service discovery to **10.10.0**, OpenTelemetry hosting and OTLP exporter to **1.19.1**, and the ASP.NET Core, HTTP and runtime instrumentation packages to **1.19.0**. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#1-the-solution)
- Spec 010. Build and migration subprocesses use project paths relative to their working directory so NuGet sees one identity for each project on macOS. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#1-the-solution)
- Spec 010. Select `AddViteApp` or Aspire's dedicated `AddNextJsApp` from `targets.web`. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#1-the-solution)
- Spec 010. `Trivia:StartWeb` and `Trivia:UseDataVolume` default to true and can be disabled for API integration tests. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#1-the-solution)
- Spec 010. Allow HTTP explicitly in the AppHost's loopback development profile. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#dev-proxy-fr-as-07)
- Spec 010. The Vite config accepts `API_URL` from the process or the mode's `.env` files. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#dev-proxy-fr-as-07)
- Spec 010. Wire the provider into the Vite template's `<Refine>`. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#data-provider-fr-as-06)
- Spec 010. The generated list query always accepts `id:in` as a lookup by the primary key, including on resources that omit the key from their general filter allowlist. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#data-provider-fr-as-06)
- Spec 010. Generate openapi.json with .NET 10.0.12 and copy it to web/openapi/api.openapi.json. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#3-the-contract-loop-fr-as-04-fr-as-05-fr-as-08)
- Spec 010. The Vite template pins pnpm to the workspace version, adds contract-sync as a development dependency and includes zod for the generated schemas. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#3-the-contract-loop-fr-as-04-fr-as-05-fr-as-08)
- Spec 010. Assert the populated slots against each fixture entity's enabled operations. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#3-the-contract-loop-fr-as-04-fr-as-05-fr-as-08)
- Spec 010. The route is hosted by `packages/dev-service` behind `DevHost`. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#3-the-contract-loop-fr-as-04-fr-as-05-fr-as-08)
- Spec 010. The backend CLI runs from the solution root or its web directory. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#3-the-contract-loop-fr-as-04-fr-as-05-fr-as-08)
- Spec 010. After the whole CLI loop succeeds, record the model revision reported by `write` and the field summary in the version 1 Blueprint lock. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#3-the-contract-loop-fr-as-04-fr-as-05-fr-as-08)
- Spec 010. Scaffold a local `.config/dotnet-tools.json` pinned to `dotnet-ef` **10.0.12**. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#3-the-contract-loop-fr-as-04-fr-as-05-fr-as-08)
- Spec 010. Backend write and migration results give the build command and contract-sync and drift steps. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#3-the-contract-loop-fr-as-04-fr-as-05-fr-as-08)
- Spec 010. The explicit `--api dotnet-minimal` layout places the Vite app and its blueprint in `web/` and leaves room for the solution's `src/` directory. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#4-first-run-of-a-new-app)
- Spec 010. Use Aspire's YARP static website publishing for Vite, with the same `/api` prefix in production. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#5-publishing-fr-as-09-should)
- Spec 010. Let `Aspire.AppHost.Sdk/13.6.5` supply the matching AppHost package implicitly. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#5-publishing-fr-as-09-should)
- Spec 010. `Category=Integration` covers the Aspire test and the existing PostgreSQL integration suite. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#6-tests)
- Spec 010. Use `--web-dir <solution-relative directory>` on `new --api dotnet-minimal` and `backend` to place the web app elsewhere in the solution. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#7-open-points)
- Spec 010. Keep Refine resource keys tied to the contract collection path. [LLD-10](lld/LLD-10-aspire-solution-and-contract-loop.md#7-open-points)
- Spec 011. BankAdmin uses `fullName`, standard Refine edit and show routes, list navigation, and the synced `approveKycCustomer` ID. [LLD-11](lld/LLD-11-mvp-crud-admin.md#example-blueprint)
- Spec 011. The starting edit form omits `notes` and the list omits `creditLimit` so the designer can add them. [LLD-11](lld/LLD-11-mvp-crud-admin.md#example-blueprint)
- Spec 011. The Node and browser tests share disposable solutions and copy the committed Radix UI, hooks, utilities and CSS. [LLD-11](lld/LLD-11-mvp-crud-admin.md#scripted-checks)
- Spec 011. Aspire Testing uses dynamic API ports and an ephemeral database. The Node parent closes the host through stdin. [LLD-11](lld/LLD-11-mvp-crud-admin.md#scripted-checks)
- Spec 011. The MVP browser project runs the generated app and designer proxy on configurable ports 5476 and 4576. [LLD-11](lld/LLD-11-mvp-crud-admin.md#browser-checks)
- Spec 011. The browser test changes one request payload to exercise a real ASP.NET field validation response. [LLD-11](lld/LLD-11-mvp-crud-admin.md#browser-checks)
- Spec 011. The inspector edits the installed show header's Back button and verifies byte-exact undo. [LLD-11](lld/LLD-11-mvp-crud-admin.md#browser-checks)
- Spec 011. The drift test adds `notes` with the field tool, then separates enum declaration and removal from the one-field `segment` addition. [LLD-11](lld/LLD-11-mvp-crud-admin.md#drift-scenario)
- Spec 011. The backend comparison counts one EF migration as its two generated files and the updated model snapshot. [LLD-11](lld/LLD-11-mvp-crud-admin.md#drift-scenario)
- Spec 011. The browser's drift case starts a second, isolated AppHost on the revised solution and forwards the list request to its real API while keeping the Vite and designer ports fixed. [LLD-11](lld/LLD-11-mvp-crud-admin.md#drift-scenario)
- Spec 011. Measure launcher start through the first Status header render and count model lines between the unchanged ends of the edit. [LLD-11](lld/LLD-11-mvp-crud-admin.md#measurements)
- Spec 011. Run uncached tools:mvp in required mode before tagging a real release. A dry run reports the planned check. [LLD-11](lld/LLD-11-mvp-crud-admin.md#release-check)

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
