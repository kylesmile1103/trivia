# BRD: Trivia Blueprint (2026-11-25)

Business requirements for the blueprint track: a typed, compilable app description that turns
into a real React + shadcn and ASP.NET Core codebase, which Trivia then edits. It is the outcome
of the Openblocks port assessment (research report, 2026-11-25) and the choices Kyle made after
it. `SRS.md` turns these into testable requirements, `HLD.md` into an architecture.

Decisions marked ⚑ were made by the agent while writing these documents and wait for review,
the same convention as `docs/product.md`.

## 1. Background

Kyle asked whether to port Openblocks (an abandoned, AGPL-3.0 low-code builder) to Next.js,
shadcn/ui and .NET 10 with Aspire, with a better DSL that compiles to React and .NET code. The
assessment found every enhancement feasible but a port the wrong vehicle:

- Openblocks' last release was March 2023, and its code is AGPL-3.0. A translation into C# or
  new TSX would most likely be a derivative work, so it could not ship under MIT beside Trivia.
- What the port would replace (the antd component layer, the runtime-interpreted DSL, the
  WebFlux server) is nearly everything it contains. Only concepts are worth keeping.
- The value is in the new DSL and in compiling it to code the user owns. That fits Trivia,
  which already edits real source, reads the user's shadcn components and syncs an OpenAPI
  contract.

Kyle accepted the recommendation: **grow Trivia (strategy C), clean-room, one-way eject**.

## 2. Problem

Trivia is a day-2 tool: it needs an app that already exists. Teams that standardize on .NET and
React have no open source way to get from "describe an internal tool" to a governed, reviewable
codebase in their own stack:

- Retool-class builders do not eject runnable code. Their apps live in a proprietary runtime.
- AI app builders write real code, but nothing typed sits between the prompt and the code, so
  the output is hard to validate, review or regenerate.
- No credible open source .NET-native builder exists (unverified absence from the research).

## 3. Business goals

| ID | Goal | Measure |
| --- | --- | --- |
| BG-1 | Extend Trivia from day 2 to day 1 without giving up "the code is the truth" | A blueprint becomes a codebase that Trivia's existing tools edit with no special casing |
| BG-2 | Own the ".NET + React internal tool with real code" niche | The MVP emits an Aspire solution that builds and runs |
| BG-3 | Make AI-authored apps governable | An agent authors a complete app through guarded, validated operations over MCP |
| BG-4 | Stay MIT and legally clean | No Openblocks or Lowcoder code is read, translated or given to agents |
| BG-5 | Stay small enough for one developer with agents | MVP in 6 to 9 months (research estimate, inference) |

## 4. Stakeholders and users

| Who | Role | Needs |
| --- | --- | --- |
| Kyle | Owner, architect, first user | A tool he uses on real internal tools; skills in .NET and React pay off |
| P1: internal-tool developer in a .NET + React team | Primary user | Scaffold a CRUD back office in minutes, then keep full control of the code |
| P2: coding agent (Claude Code, Cursor, any MCP client) | Primary author of blueprints | A typed target with precise diagnostics, guarded writes and a way to check its work |
| P3: tech lead or reviewer | Approves what lands | Small, readable diffs for blueprints and for generated code; ordinary code afterwards |
| P4: non-developer builder | Deferred | A hosted builder and runtime. Only this persona justifies Phase 4 |

## 5. Scope

**In (Phases 0 to 3, specified in full):**

- Phase 0: the blueprint schema, component manifests, the expression compiler, the agent surface.
- Phase 1: blueprint to React code (Vite), the component kit, the designer's Blueprint panel.
- Phase 2: the data model DSL, C# code generation, the Aspire solution and the contract loop,
  and the MVP slice (a CRUD admin end to end).
- Phase 3: Next.js App Router as a second code generation target, and Trivia's editor working
  on Next.js apps.

**Out (Phase 4, described in the HLD only, built only if demand appears):** a hosted
multi-tenant runtime, an interpreter, organisations and RBAC, data source connectors beyond
REST/OpenAPI and SQL, a plugin marketplace.

**Never in this track:** porting or importing Openblocks or Lowcoder code; server-side
evaluation of user JavaScript; round-trip of arbitrary code back into a blueprint; MongoDB.

## 6. Business requirements

Priority is MoSCoW for the MVP (end of Phase 2). Phase 3 items are Must for Phase 3.

| ID | Requirement | Priority | Phase | Goal |
| --- | --- | --- | --- | --- |
| BR-01 | An app is described by versioned, typed blueprint documents kept in git, with small local diffs | Must | 0 | BG-1, BG-3 |
| BR-02 | Blueprint components are the user's own shadcn components, described by typed manifests | Must | 0 | BG-1 |
| BR-03 | Bindings are expressions checked when saved, not when run | Must | 0 | BG-3 |
| BR-04 | Agents author and change blueprints through guarded operations over MCP, and people through the designer | Must | 0, 1 | BG-3 |
| BR-05 | A blueprint compiles to idiomatic React + shadcn code that type-checks and that the user owns | Must | 1 | BG-1, BG-2 |
| BR-06 | What the user previews is the compiled code. No second runtime exists | Must | 1 | BG-1 |
| BR-07 | After eject the code is the truth: Trivia's byte-preserving day-2 tools work on it, and nothing regenerates over a hand edit | Must | 1 | BG-1 |
| BR-08 | A data model compiles to an ASP.NET Core API on .NET 10 with EF Core and PostgreSQL, with a place for hand-written code that regeneration never touches | Must | 2 | BG-2 |
| BR-09 | The generated solution runs under Aspire with one command, and the API's OpenAPI document feeds the frontend's contract sync | Must | 2 | BG-2 |
| BR-10 | Next.js App Router is a second target for generated frontends, using server rendering where the blueprint allows it | Must (P3) | 3 | BG-2 |
| BR-11 | Trivia's editor works on Next.js apps | Must (P3) | 3 | BG-1 |
| BR-12 | The project stays MIT, clean-room, with a written policy that binds people and agents | Must | 0 | BG-4 |
| BR-13 | The hosted runtime, connectors and RBAC are deferred behind an explicit demand gate | Must | 4 | BG-5 |
| BR-14 | Generated apps can require sign-in through OIDC | Should | 2 | BG-2 |
| BR-15 | A blueprint has a readable, JSX-like projection for review and for agents to read | Should | 0 | BG-3 |

## 7. Success metrics

- **MVP acceptance (BG-1, BG-2):** from an empty folder, a blueprint for one Postgres schema
  (a table page, a detail form, filters, two actions) becomes an Aspire solution that passes
  `dotnet build`, `tsc` and its generated tests, runs with one command, and is then edited
  through Trivia with byte-exact undo. Specified in `specs/011-mvp-crud-admin`.
- **Agent authoring (BG-3):** a fresh Claude Code session with only the Trivia MCP server
  builds that app from a one-paragraph prompt, without reading generated code to fix it.
- **Dogfooding:** Kyle builds one real internal tool with it within a month of the MVP, the
  same bar `docs/product.md` set for the day-2 tools.
- **Diff quality (P3):** a one-field blueprint change is a diff of fewer than ten lines, and a
  regenerated backend changes only `*.g.cs` files and one migration.

## 8. Assumptions and constraints

- **Target user is still the developer.** Day 1 joins the product; the non-developer builder
  does not. This supersedes "Day 1 is out of scope" in `docs/product.md` for this track only.
- ⚑ **Generated frontends are Refine + shadcn apps**, so the columns, form fields, drift and
  new-resource tools already built apply to them unchanged (ADR-0009).
- **Generated backends are minimal API slices on PostgreSQL** (Kyle's choice). A Clean
  Architecture profile and SQL Server or Oracle providers are not planned.
- **No import of Openblocks or Lowcoder apps.** It would add legal care for little gain (BR-12).
- One senior developer with coding agents. Estimates are the research's, and are inference.
- Versions move fast: Next.js 16.x, Aspire 13.x, .NET 10 LTS and shadcn with Base UI as the
  default were current on 2026-11-25. Each is pinned and re-verified when its phase starts.

## 9. Risks

| Risk | Likelihood | Impact | Response |
| --- | --- | --- | --- |
| AGPL contamination by reading or translating Openblocks code, including by agents | Medium | High | ADR-0001, the constitution's first rule, no such source in any agent context |
| Scope grows into a full Retool clone | High | High | Phase 4 gate (BR-13); the MVP slice is the only definition of done for Phase 2 |
| Table, date and tree components eat the schedule | High | Medium | A 25-component kit, refine-ui's data table, the gaps listed and deferred (LLD-06) |
| Users expect code to flow back into the blueprint | High | Medium | One-way eject stated everywhere; after eject, Trivia is the editor (ADR-0003) |
| AI app builders make blueprints look redundant | Medium | High | Position the blueprint as what agents write to, not a rival to them |
| Day 1 distracts from proving day 2 on a real codebase | Medium | Medium | The day-2 backlog in `HANDOFF.md` keeps its priority until Kyle reorders it |
| Next.js churn (Cache Components become the default in 17) | Medium | Low | Next.js is a target behind an interface, never the platform core (ADR-0008) |

## 10. Open questions

Defaults were taken so the specifications could be written. Each is cheap to change before its
phase starts.

1. Should day-1 work start before Trivia's day-2 tools are proven on a real internal tool?
   Default: the specs are ready, and the order is Kyle's call.
2. Must generated .NET follow a bank's house architecture one day? Default: no (section 8).
3. A hosted SaaS later? Default: no. It is the Phase 4 gate, and clean-room keeps it possible.
4. Is Refine the right base for generated frontends (⚑ ADR-0009), or plain TanStack Query?

## 11. Milestones

| Phase | Content | Estimate (inference) | Exit |
| --- | --- | --- | --- |
| 0 | Schema, manifests, expressions, agent surface | 4 to 6 weeks | An agent writes a valid blueprint and gets precise diagnostics |
| 1 | React codegen (Vite), kit, Blueprint panel | 2 to 3 months | Pages preview and eject into an existing Refine app |
| 2 | Data model, .NET codegen, Aspire, MVP slice | 2 to 3 months | MVP acceptance (section 7) |
| 3 | Next.js target, Trivia on Next.js | 1 to 2 months | The MVP app emitted for Next.js and edited in the designer |
| 4 | Hosted runtime | Not estimated | Only after the demand gate |
