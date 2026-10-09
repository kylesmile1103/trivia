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
features, until the jobs above are in use. The user lifted the freeze on 2026-10-09 for two of
them, after trying the designer on refine-admin (see "Editor: layers and pages" below):
moving elements from the Layers tab, and a Pages tab to go between routes. The Data tab's raw TanStack-hooks path
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
| 5. Forms that survive real code | On `refine-admin`'s edit page, written in Refine's `<FormField>` style with a grid wrapper and a schema-level `.refine`: fields read, add, remove and rebuild like the others. After a spec change to a bound (`maxLength`), drift's fix edits the rule in place, so custom calls and messages stay. After a change to required-ness, the fix adds or removes `.optional()`. A removed field's other mentions are listed. |
| 6. Drop-in inferencer | `<OpenApiShowInferencer />` in a route renders the contract's page with live data before any file exists. Eject writes it and switches the route, as one undo entry. |

## Slice 5: forms that survive real code (⚑ planned by the agent, 2026-10-09)

The user's own idea was an AOT JSON Schema → TSX compiler with day-2 sync. Assessed with them,
it was reduced to what their real apps need: **OpenAPI stays the input** (no JSON Schema or
uiSchema layer), and the new abilities go into what exists. Real Refine forms differ from
slice 2's in four ways, each made to work:

1. **Refine's own form style.** Refine's shadcn docs and registry write
   `<Form {...form}>` + `<FormField control name render>` + `FormItem`/`FormLabel`/`FormControl`/
   `FormMessage` (shadcn's older `form` component). Slice 2 only read `<Controller>` + `<Field>`.
   - Both are read: a field's control is a `Controller` or a `FormField`.
   - ⚑ A new field is written in its form's style: the style its fields already use. An empty
     form, and new pages, take the style most of the project's forms use. With no forms yet,
     `ui/field.tsx` means `Field`, else `ui/form.tsx` means `FormField`. A `FormField` needs
     `<Form>` around it; without one, `Field` is used.
2. **Hand edits to the rule.** Developers add messages, `.refine(…)`, `.transform(…)` to the
   zod rules, and `.refine` to the whole schema.
   - Engine: a value path through `z.object({…}).refine(…)` reaches the object. A method on a
     call or literal unwraps to its receiver when the receiver holds the literal. Before, it
     unwrapped into the callback.
   - Engine: **chain ops** edit one call of a method chain in place. `setCallArgument`
     replaces or appends one argument of `.max(…)`. `insertCall` adds `.max(500)` before the
     first of the calls it is told to stay before. `removeCall` drops `.optional()`. They keep
     the chain's layout (one call per line or inline) and round-trip byte for byte.
   - Engine: call descriptions carry the chain (`z.string`, `min(2, "…")`, `optional()`), so
     adapters read a rule without regexes.
3. **Bounds from the contract.** The manifest gains each field's `constraints` (minLength,
   maxLength, minimum, maximum, pattern), additive and optional. New rules use them:
   `.min(n, "Enter at least n characters.")`, `.max(…)`, `.regex(new RegExp("…"))`.
   - Drift `constraint_changed`: the contract states a bound and the rule's differs or is
     missing. ⚑ A bound only the form has is left alone: it may be deliberate.
   - Drift `optionality_changed`: the contract now requires a field the rule makes optional
     or nullable. ⚑ The other way round (a form stricter than the API) is not drift.
   - Both are fixed by a field change `align`, resolved when planned. It edits the bounds and
     modifiers in place with chain ops. A new bound goes before modifiers (`.optional()`,
     `.refine(…)`, …).
   - ⚑ Messages: the old bound in the message is replaced by the new one when it appears in it
     exactly once (`"At most 100 characters"` → `"… 500 …"`). Otherwise the message is left as
     written.
4. **Layout the developer chose.**
   - ⚑ Without an index, a new field goes right after the nearest field before it in the
     contract's order, inside that field's own wrapper (grid, card, tab). Without one, it goes
     before the nearest field after it, else at the end. A field under a `{cond && …}` guard
     is never an anchor.
   - Plans track locators by index-path prefix, so several changes in one plan work across
     wrappers. Before, they were refused.
   - The engine's `setProperty` puts a new key before trailing spreads
     (`{ name: "", ...defaults }`), so values passed in still win. Before, it appended after
     the spread and overrode them.
5. **Removed fields still used elsewhere.** A field removed from the contract may still be
   named in other code: `data.email` in a `.refine`, `watch("email")`.
   - The engine's `mentions(file, name)` finds member accesses and string arguments with that
     name, outside JSX attributes and object keys.
   - A `missing_field` issue lists those lines, and a plan that removes the field returns them
     as `warnings`.
6. **Widgets.** ⚑ A `Textarea` for strings with `maxLength` over 255 when the project has
   `ui/textarea.tsx`, and `type="password"` for `format: password`. Switch, radio and date
   picker wait: without a uiSchema, nothing would choose them.

Example and tests:
- `refine-admin` gets `ui/form.tsx` (Refine's registry version, adapted to `radix-ui`).
- `customers/edit.tsx` is rewritten in that style, with a two-column grid and a schema
  `.refine`.
- The spec gains `notes` (maxLength 1000).
- Engine unit and round-trip tests for the chain ops.
- Plugin tests reproduce the user's day-1.5 fixture: a grid wrapper, a root `.refine`, a
  custom message and `...defaultValues`. Bytes outside the edits are checked, and `tsc` runs
  on every result.
- The e2e drift test extends to a bound change.

Shipped in four parts, each through the full gate:
- 5a: engine;
- 5b: constraints and widgets;
- 5c: FormField style and placement;
- 5d: drift.

## Slice 6: a drop-in inferencer, from the contract (⚑ planned by the agent, 2026-10-09)

The user's idea: `@trivia/openapi-inferencer`, a contract-driven replacement for Refine's
`@refinedev/inferencer`. Refine's inferencer guesses a page at runtime from one live record:
- it shows nothing for an empty table;
- it can't see bounds or enums;
- its code ends in a copy-paste modal.

**Assessment.** Most of it already exists. Slice 4 generates list, create, edit and show pages
from the contract, with zero records, and writes them to disk as one undo entry. Slice 5 added
bounds, enums and the `FormField` style. What is new is the **entry point**: a component a
Refine developer drops into a route, the way they already use Refine's inferencer. The page
runs there before any file exists, and one click writes it and switches the route over. For
Refine users that is the most familiar pitch Trivia has, so it is worth building, as a thin
layer on the existing generator.

**Design.**
- **Package** `packages/trivia-inferencer`, npm name `@trivia/openapi-inferencer` (as asked).
  - It exports `OpenApiListInferencer`, `OpenApiCreateInferencer`, `OpenApiEditInferencer` and
    `OpenApiShowInferencer`. Props: `{ resource?, ejectPath?, hideFields?, title? }`.
  - The resource comes from `resource`, else Refine's route context.
  - ⚑ It uses `useResourceParams()`: Refine 5 removed `useResource()` (its 4.x→5.x migration
    guide). The peer is `@refinedev/core >= 5`.
  - ⚑ Peers are only `react` and `@refinedev/core`; there are no runtime dependencies. Versions
    follow the repo (React 19, TypeScript 6), not the spec's React 18 and TS 5.5.
- **The preview is the generated code itself** (⚑, instead of separate dynamic table and form
  renderers).
  - The plugin serves each requested page as a module at `/@trivia/preview/<id>.tsx`, built by
    slice 4's generator. Vite compiles it with the project's own aliases, components and React
    refresh: a probe on Vite 8 confirmed it.
  - The inferencer imports it and renders it inside the app's `<Refine>`, so it works against the
    real data provider.
  - What you preview is byte for byte what gets ejected; two renderers would drift apart.
- ⚑ **No second generator.** The spec's list, form and column generators are slice 4's
  `scaffold.ts`, which now also takes `hideFields` and `title`. So:
  - ⚑ data goes through Refine's hooks (`useTable`, `useForm`, `useShow`) and the app's data
    provider, not raw TanStack Query hooks (a standing product decision, above);
  - ⚑ booleans keep a `Checkbox`, as everywhere else Trivia writes forms; `Switch` waits.
- **Eject** goes through the plugin's API like every other edit (⚑, not a new
  `/__trivia/eject`). `POST /refine/eject` plans it; `/batch` applies it as one undo entry:
  - `createFile` for the page, at `ejectPath` or the conventional path;
  - a new engine op, `replaceElement`, that swaps `<OpenApiListInferencer … />` for
    `<CustomerList />` where it is, and adds the import. The plugin stamps every element with
    its locator, so the inferencer knows its own.

    The element sits in `element={…}`, an expression, where the JSX ops refuse siblings.
    Replacing one element with another there is still a plain span splice. The inferencer's
    import goes when its last use does (rule 9).
  - Without a locator, the page is still written, and the reply says which element to swap.
- **Banner.** "Inferred from the OpenAPI contract: Customer", with **View code** (a code drawer
  with Copy: ⚑ a `<pre>`, not Monaco) and **Eject to disk** (confirm, with the target path).
  - ⚑ Its styles are inline: Tailwind doesn't scan `node_modules`.
  - In a production build, or with no Trivia dev server, it says so instead of rendering.
- **Tests:**
  - the engine op, with round trips and import handling;
  - plugin tests: previews for every kind with the example's mock emptied (no records). The spec's
    fixture (`minLength: 5`, `enum: ["Active", "Suspended"]`, `format: password`) gives a
    `FormField` form with `.min(5`, `z.enum(["Active", "Suspended"])` and a password input, under
    `tsc`;
  - eject plans, including undo;
  - unit tests of the package's hooks: the eject payload and the dev server's errors;
  - an e2e on `refine-admin`, whose Transactions show route renders `<OpenApiShowInferencer />`:
    the preview shows a real transaction, Eject writes `transactions/show.tsx` and switches the
    route, and undo restores both.

Shipped in three parts, each through the full gate:
- 6a: engine `replaceElement`;
- 6b: plugin previews and eject;
- 6c: the package, the example and the e2e.

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
- **Slice 5, forms that survive real code: done (2026-10-09).**
  - 5a, engine: done (2026-10-09). Value paths follow method chains to their literal, and call
    descriptions carry the chain. The chain ops are in `ops/chains.rs`. `setProperty` adds new
    keys before trailing spreads, and `mentions` is in `src/mentions.rs`; the napi binding exposes
    it. Value snippets now refuse `a, b` (a sequence would become two items).
  - 5b, constraints and widgets: done (2026-10-09). The manifest's fields carry `constraints`.
    New rules carry their bounds (`.min`, `.max`, `.regex`, `.gt`, `.lt`), with messages Trivia
    can recognize later. Long text gets a `Textarea`, and `format: password` a password input.
    The example's spec gains `notes` (maxLength 1000). The Data tab's add menu shows a field's
    bounds on hover.
  - 5c, FormField style and placement: done (2026-10-09).
    - Forms are read with `Controller` or `FormField` controls. New fields are written in the
      form's style, empty forms and new pages in the project's.
    - New fields are placed by contract order inside the developer's wrappers, never under a
      guard. Plans track locators by index-path prefix, and a rebuilt field returns to its slot.
    - Example: `ui/form.tsx` (Refine's registry version), and `customers/edit.tsx` rewritten in
      that style with a grid and a schema `.refine`.
    - Tests: `test/refine-formfield.test.ts` (including the day-1.5 fixture, checked line by
      line) and an e2e on the edit page.
  - 5d, drift: done (2026-10-09).
    - `constraint_changed` and `optionality_changed` issues, both fixed by `align`, which edits
      the rule with chain ops (`src/refine/rules.ts`). Messages that name the old bound follow
      it.
    - `missing_field` lists the file's other mentions of the field, and the removal plan
      returns them as `warnings`. The designer shows them under the issue and as toasts after a
      fix.
    - The e2e drift test now includes a bound change.
- **Slice 6, drop-in inferencer: done (2026-10-09).**
  - 6a, engine `replaceElement`: done (2026-10-09). It swaps one element for another where it
    stands, including inside `element={…}`. Imports come and go as with insert and remove, and
    the selection rebases. It's exposed over HTTP, MCP and the designer's op types.
  - 6b, plugin previews and eject: done (2026-10-09). `POST /refine/preview` and
    `/refine/eject` work on the slice-4 generator, which now takes `hideFields` and `title`.
    Preview modules are served at `/@trivia/preview/<id>.tsx`, unstamped, and invalidated on a
    sync. Tests: `test/refine-inferencer.test.ts` (no records anywhere; the spec's FormField
    fixture under `tsc`; eject with undo).
  - 6c, the package: done (2026-10-09). `packages/trivia-inferencer` (`@trivia/openapi-inferencer`):
    - the four inferencers, `useResourceContract` and `useEjectToDisk`;
    - a banner with View code and Eject to disk;
    - the live preview with an error boundary.

    `refine-admin` renders Transactions' show route with `<OpenApiShowInferencer />`. A preview
    also imports a stylesheet with its Tailwind classes, built by the app's Tailwind against its
    theme: classes no file on disk had used were missing, which a screenshot showed. Tests: the
    package's own (the eject payload and the dev server's errors; the banner, drawer and eject
    flow in jsdom) and `e2e/refine/inferencer.spec.ts`.
- Known limits of slices 1–6:
  - A value op renumbers the JSX locators after the literal it edits (rule 4). The designer
    drops a selection in that file rather than guess, and so does an agent's edit.
  - A header is renamed by `setProperty` or `setText`; the panel has no rename yet.
  - Pages come from `src/` files that import `@refinedev/react-table` or
    `@refinedev/react-hook-form`.
  - A form's fields are found through `zodResolver(schema)` and `<Controller name>` or
    `<FormField name>`; forms built with `register()` or another resolver are not read.
  - Moving a field moves its control only; the schema's and defaults' key order stay as
    written (order there doesn't show).
  - A field under a `{cond && …}` guard is read, but Trivia doesn't remove, move or rebuild
    it: the engine refuses, and says to edit it by hand.
  - The inferencer needs Refine 5 and Trivia's dev server.
    - Eject doesn't touch `<Refine resources>`: the route the inferencer sits in is the
      developer's.
    - The preview's stylesheet is for Tailwind v4 apps; others get the page unstyled by
      classes no file uses yet.
  - Drift reads enum options from a column header's source excerpt (600 bytes). A longer header
    gets no enum verdict rather than a wrong one. A rebuilt column or field takes the generated
    shape: custom cells, widgets or messages in it are replaced.
  - New pages assume refine-ui and shadcn's `field` (or `form`, by the project's style) in
    their usual places, Refine's route
    conventions, and an app that renders `<Refine resources={[…]}>` with `<Route path>`s. A
    list shows the first six scalar fields; object and array body fields are left as comments
    in forms.

## Editor: layers and pages (asked by the user, 2026-10-09)

The design was agreed with the user before it was built. It ships in three slices, each
through the full gate.

- **A. Layers tab moves elements: done.** Drag a row onto another: its top quarter is before
  it, its bottom quarter after it, its middle inside it as the first child. A leaf splits in
  halves; an open row's bottom edge means inside; a component's root takes only inside
  (`features/layers/drop.ts`). Alt+↑/↓ moves the focused row past a sibling (the right-click
  menu's Move up/down rules). The canvas makes every edit through the shared canvas API
  (`move`, `moveStep`, `moveRefusal`, `version`): the same `move` op as a canvas drag (and
  `moveNode` at index 0 for inside), the engine's names as guards, and the tree's canvas
  version, so a tree that went stale is refused. `locator.ts` moved to `shared/lib/`, since
  two features read locators now.
- **B. Routes from the source: done.** `GET /routes` and MCP `trivia_list_routes`
  (`packages/vite-plugin-ast-locator/src/routes/`, `docs/api.md` `AppRoute`): React Router
  `<Route>` trees and route objects (`createBrowserRouter` and kin, `useRoutes`), a page's own
  `<Routes>` under a splat route joined onto its base, TanStack Router (file-based
  `createFileRoute`, code-based `createRoute`), and Refine resource labels. Read statically:
  the engine's outline, inspect and value descriptions, with Vite resolving each page's
  module. The engine now also lists a hook call a scope returns (`return useRoutes([...])`).
- **C. A Pages tab: done** (`features/pages`). It lists the routes with their labels, URLs and
  page files, marks the one the canvas is on (a catch-all only when nothing else matches), and
  loads a route on click. A route with params asks for them, prefilled from the canvas URL when
  it is on that route, else with the last value given for that param. The path field shows the
  canvas URL and opens any path. Loading is a full load of the iframe (`canvas.navigate`), so it
  works with any router; the canvas notes its URL after each load and re-render
  (`store.canvasPath`), so in-app navigation moves the mark too.
  The left column grew from 240 to 272 px so its four tabs fit (at 240 the Data tab slid under
  the canvas). `e2e/refine/routes.spec.ts` covers it end to end.

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
