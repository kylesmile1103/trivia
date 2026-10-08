# Product: what Trivia is for (2026-10-09)

This is the product decision behind the work. `HANDOFF.md` has the status, `architecture.md`
the code layout. **Decided with the user**: the user, the jobs, columns first. **Decided by the
agent while the user was away** (marked ⚑ below): the user asked for these calls to be made and
reviews them afterwards.

## Who it is for

Developers who maintain **internal tools and admin consoles** built with **Refine + shadcn/ui**
against **OpenAPI backends**. The codebase already exists (day 2): scaffolded by Refine or
written by hand, then grown for months. Day 1 (scaffolding a new app) is out of scope. It may
join a larger ecosystem later.

The user is the first of these developers. Success in the first month: **they use Trivia on one
of their real internal tools for real tasks**, not a demo.

## Why this and not a general visual editor

The market scan (2026-10-09) found visual editing of real code is now common. Cursor bundles a
visual editor. v0, Lovable, Bolt and Replit write visual edits back to source. Onlook, Tempo,
Builder Fusion and small AST editors (CrossUI, Overlay) do the rest. Byte-preserving edits are
what developers need before they trust a tool, but they're no reason to switch. What none of
them does is connect the **API contract** to the pages. Refine's own shadcn pages show the gap:

- types are hand-written (`types/resources.ts`);
- every form hand-writes its zod schema;
- Refine's Inferencer guesses pages from live responses and has no shadcn target.

So Trivia is **the contract-aware day-2 tool for Refine apps**:
- open source (MIT);
- local;
- works with any agent that speaks MCP.

The canvas is where a human points and reviews. Agents and the panels do the edits, through
the same guarded, byte-preserving operations.

## The jobs, in order

1. **Columns.** Add, remove or reorder a list column from the contract. The cell renders by
   field type and gets the matching filter.
2. **Form fields.** Add a contract field to a create/edit form: the zod rule, the default value
   and a `<FormField>` with a widget chosen by type, as one undo entry. Also remove and reorder.
3. **Contract drift.** After a sync, list what each page references that the contract changed:
   removed or retyped fields, and newly required fields a create form misses. Each comes with a
   fix.
4. **New resource from the contract.** List, create, edit and show pages, the `resources` entry
   and the routes.
5. Quick tweaks and point and ask (built: `docs/mcp.md`).

Frozen: general editor features (canvas, inspector, style controls) get fixes, not new
features, until the jobs above are in use. The Data tab's raw TanStack-hooks path
(`bindQuery`) stays as is. In a Refine app, data goes through Refine's hooks, so Trivia writes
`useTable`/`useForm` code, never raw TanStack hooks. Generating a Refine data provider from
OpenAPI is day 1, so it's out.

## Architecture (⚑ the shape is the agent's call)

```
contract (trivia.manifest.json) ─┐
page source ── engine: values ───┼─ plugin: Refine adapter ── HTTP /refine/*, MCP tools
                                 │        (plans ops)               │
canvas ── designer: Columns panel ┴──── dispatches the ops ──────────┘
```

- **Engine: values, not just JSX.** A *value path* addresses a node inside an object or array
  literal by binding and key: `<file>#<scope>#columns[id=status]`. The scope is the component, or
  `-` for module level. The path unwraps `useMemo(() => [...])`, `z.object({...})`, parentheses
  and TS wrappers on the way.
  - **Inspection:** `describeValues(file)` lists each scope's literal-valued bindings and hook
    calls (with type arguments), as JSON value trees.
  - **Edits:** `insertElement`, `removeElement`, `moveElement`, `setProperty`, `removeProperty`.
    They're byte-preserving like the JSX ops and match the literal's layout: one element per
    line, trailing comma, indentation. Keyed paths (`[id=status]`) are their own guard: a path
    that no longer resolves fails loudly.
  - It stays framework-agnostic. Ant Design or MUI adapters later need no engine change.
- **Plugin: the Refine adapter** (`src/refine/`).
  - **Page analysis:** finds `useTable` and its columns binding, and the resource. The resource
    comes from `refineCoreProps.resource`, else the type argument (`ColumnDef<CustomerDto>`)
    matched to the contract's `typeName`, else the file's folder name.
  - **Contract match:** the Refine resource name against the manifest resource (name, last
    base-path segment, tag).
  - **Column snippets by field type:**
    - every field gets a header with `DataTableSorter`;
    - filter: `DataTableFilterDropdownText` for strings, `DataTableFilterCombobox` for enums,
      `DataTableFilterDropdownNumeric` for numbers, `DataTableFilterDropdownDateRangePicker` for
      dates;
    - cell: a `Badge` for enums, a formatted date for dates, Yes/No for booleans.
  - **Imports** come from the page's existing imports, else from where the project keeps
    refine-ui (`components.json` aliases).
  - **Endpoints:**
    - `GET /refine/page?file=` returns the analysis, the current columns and the contract fields
      not shown yet.
    - `POST /refine/plan` returns the `Op[]` for a change. The designer dispatches it, so it
      lands in history like any edit.
  - **MCP:**
    - `trivia_get_page` reads the page;
    - `trivia_edit_columns` changes it (agents get the same plans);
    - `trivia_apply` gains the value ops.
- **Designer: a Columns panel.** When the canvas shows a Refine list page, the Data tab shows
  that page's resource, its columns in source order (drag to reorder, remove) and **Add column**
  with the contract fields not yet shown.
- **Example app** (⚑): `examples/refine-admin`, assembled by hand rather than with
  `create refine-app`. That scaffolder downloads templates, prompts interactively and runs its
  own `git init`. The app is the `vite-shadcn` preset's shape: Vite, React, Refine core, router,
  react-table and react-hook-form, with refine-ui installed from Refine's shadcn registry. It
  runs against a banking-flavoured OpenAPI mock (customers, accounts, transactions) served by a
  dev middleware. It is the e2e target for this product; the playground stays for the generic
  editor tests.

## Slices

| Slice | Done when |
| --- | --- |
| 1. Columns | On `refine-admin`: add `status` as a badge column with a filter, reorder it, remove it. Every edit is byte-preserving, one undo entry, and an agent does the same over MCP. Engine fixture tests, plugin tests, e2e. |
| 2. Form fields | On the customer create/edit pages: add a contract field (zod + default + FormField, one undo entry), remove one, reorder. Widgets by type. |
| 3. Contract drift | After the spec changes: the Data tab and `trivia_contract_drift` list each page's broken references, with fixes from slices 1–2. |
| 4. New resource | Pages, resource entry and routes for a contract resource that has none. |

## Status

- **Slice 1, columns: done (2026-10-09).**
  - Engine: value paths and value ops (`crates/trivia_oxc_engine/src/values.rs`,
    `src/ops/values.rs`).
  - Plugin: the adapter (`packages/vite-plugin-ast-locator/src/refine/`), with
    `/refine/pages`, `/refine/page`, `/refine/columns/plan`, and MCP `trivia_get_page` and
    `trivia_edit_columns`.
  - Designer: the Columns panel at the top of the Data tab
    (`features/data-explorer/PageColumns.tsx`).
  - Example: `examples/refine-admin`.
  - Tests: engine fixtures with round trips, plugin tests (including `tsc` on a page with a
    column of every field type), and `e2e/refine/columns.spec.ts`.
- **Slice 2, form fields: done (2026-10-09).**
  - Plugin: `src/refine/form.ts` (form pages) and `fields.ts` (rule, default, Controller), with
    `/refine/fields/plan` and MCP `trivia_edit_fields`.
  - Designer: the Data tab's page card shows a form's fields.
  - Example: customer create and edit pages (`Field` + `Controller`, since shadcn v4 has no
    `form`) and a row-actions column.
  - Tests: plugin tests, including `tsc` with every body field added to both forms, and
    `e2e/refine/fields.spec.ts`.
  - New columns now go after the last data column, before row actions.
- **Slice 3, contract drift: done (2026-10-09).**
  - Plugin: `src/refine/drift.ts` (missing fields, changed enums and types, newly required
    fields, each with a fix), `/refine/drift` and MCP `trivia_contract_drift`.
  - Designer: an "Out of step with the contract" list in the Data tab with a button per fix,
    and **Sync** next to "Spec changed".
  - Tests: a plugin test that changes the spec, syncs, applies every fix and type-checks the
    result; `e2e/refine/drift.spec.ts`.
- **Slice 4, new resource: done (2026-10-09).**
  - Engine: value paths reach JSX attributes (`<Refine>.resources`).
  - Plugin: `src/refine/scaffold.ts` (list, create, edit and show pages, written like the
    others), with `/refine/resources`, `/refine/pages/plan` and MCP `trivia_add_pages`.
  - Designer: in a Refine app, each resource in the Data tab shows its pages and offers
    **Add … pages**. The raw TanStack Table and Create form actions are hidden there.
  - Tests: plugin tests that add Accounts' missing pages and a new Cards resource from a spec
    change, type-check them, and undo; `e2e/refine/pages.spec.ts`.
- Known limits of slices 1–4:
  - A value op renumbers the JSX locators after the literal it edits (rule 4). The designer
    drops a selection in that file rather than guess, and so does an agent's edit.
  - A header is renamed by `setProperty` or `setText`; the panel has no rename yet.
  - Pages come from `src/` files that import `@refinedev/react-table` or
    `@refinedev/react-hook-form`.
  - A form's fields are found through `zodResolver(schema)` and `<Controller name>`; forms
    built with `register()` or another resolver are not read.
  - Moving a field moves its Controller only; the schema's and defaults' key order stay as
    written (order there doesn't show).
  - Drift reads enum options from a column header's source excerpt (600 bytes). A longer header
    gets no enum verdict rather than a wrong one. A rebuilt column or field takes the generated
    shape: custom cells, widgets or messages in it are replaced.
  - New pages assume refine-ui and shadcn's `field` in their usual places, Refine's route
    conventions, and an app that renders `<Refine resources={[…]}>` with `<Route path>`s. A
    list shows the first six scalar fields; object and array body fields are left as comments
    in forms.

## Decisions to review (⚑)

- **Positioning:** open source plus "works with any MCP agent" is the distribution story,
  rather than competing on editor features.
- **The engine learns value literals** (generic), and **Refine knowledge lives in the
  plugin.** Not the other way round, so the engine never needs to know any framework.
- **Plans, not direct writes:** the plugin returns ops and the designer dispatches them. One
  undo entry per change, the same path as every other edit.
- **The example app is assembled by hand** to match the `vite-shadcn` preset (reason above).
- **Resource matching heuristics:** an explicit `resource` beats the type argument, which
  beats the folder name. A page that matches no contract resource still shows its columns; it
  just can't add from the contract.
