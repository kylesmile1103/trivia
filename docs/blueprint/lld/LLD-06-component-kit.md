# LLD-06: Component kit

- Spec: `specs/006-component-kit` · Requirements: FR-KT-01 to FR-KT-07 · ADR-0009, ADR-0016
- Code: `packages/blueprint-compiler/kit/` (manifest JSON, one file per type) and
  `packages/blueprint-compiler/src/composites/` (`data-table.ts`, `form.ts`, `virtual-table.ts`).

## 1. What the kit is

The kit is data: a manifest (LLD-02) for each component a blueprint may use by name. It ships
no component source. The user's project gets the components from the shadcn registry and from
Refine's shadcn registry (refine-ui), and the manifests describe how to use what is there.

## 2. Published manifests (FR-KT-01)

| Fixture | Types | Registry |
| --- | --- | --- |
| `KitDisplay` | `Button`, `DropdownMenu`, `Badge`, `Avatar`, `Alert`, `Tooltip`, `Skeleton`, `Breadcrumb`, `Empty` | shadcn |
| `KitInputs` | `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `RadioGroup`, `Combobox`, `DatePicker`, `Label`, `Field` | shadcn. `Combobox` uses `popover` and `command`, and `DatePicker` uses `popover` and `calendar` |
| `KitContainers` | `Card`, `Tabs`, `Dialog`, `Sheet`, `Popover`, `Separator` | shadcn |
| `KitTable`, `KitVirtualTable` | `DataTable` | refine-ui |
| `KitForm` | `Form` | shadcn `Field` or legacy `FormField`, with Refine and Zod |

The kit contains 25 shadcn manifests and two composite manifests. LLD-02 defines the
intrinsic HTML elements. A toast is an action step.

Per type the manifest fixes: slots and their wrapper parts (`Card`: `header`, `content`,
`footer`; `Tabs`: one slot per tab, from a `tabs` prop; `Dialog` and `Sheet`: `trigger`,
`content`), events, and exposed values:

| Type | Exposes | Via |
| --- | --- | --- |
| `Input`, `Textarea` | `value: string` | `value`, `onChange`, `event.target.value` |
| `Select`, `RadioGroup`, `Combobox` | `value: string` | `value`, `onValueChange`, `value` |
| `Checkbox`, `Switch` | `checked: boolean` | `checked`, `onCheckedChange`, `value` |
| `DatePicker` | `value: Date \| undefined` | `selected`, `onSelect`, `value` |
| `Tabs` | `value: string` | `value`, `onValueChange`, `value` |
| `Dialog`, `Sheet`, `Popover` | `open: boolean` | `open`, `onOpenChange`, `value` |

The kit checks prop names for both Radix and Base UI against installed sources. Manifests
use style variants where the installed libraries expose different contracts (LLD-02 section 6).

⚑ Exact style variants take precedence over a library-family variant such as `base`.
Base UI switches and checkboxes return a boolean. Base UI selects, radios and tabs normalize
a cleared value to an empty string for the blueprint, and Select receives its empty state as
`null`. The engine recognizes Base UI's direct Select export and the inherited control props
needed for authored items and labels.

⚑ Manifest slots describe the outer registry parts. Authors place deeper parts such as
`BreadcrumbItem` and `DropdownMenuItem` as ordinary nodes in those slots. The resolver
keeps a project's installed filename for a uniquely resolved shadcn export, so a renamed
component continues compiling with its project alias.

⚑ The dev service reads the shipped kit manifests in place of the three spec 002 samples.
The spec 004 component response keeps the same `components` and `schemas` fields for the
designer and MCP clients.

⚑ `configuration` describes compiler-consumed static props without changing the analyzer's
native prop list. Select generates its trigger and value around the author-supplied item
nodes. Radix Combobox uses a searchable Command inside a Popover and commits its value on
item selection. DatePicker uses a single-selection Calendar inside a Popover. Its empty
state is undefined, and a static `selected` is an ISO calendar date. Checkbox maps Radix's
indeterminate change value to false for its boolean exposure.

⚑ Tabs takes static `tabs: [{ "name": "summary", "label": "Summary" }]`. Names are unique
slot identifiers and each generated trigger and panel shares that value. The first tab is
selected unless the author provides a value. Dialog and Sheet accept the library's title
and description parts in their content slot.

## 3. `DataTable` (FR-KT-02, FR-KT-04, FR-KT-05)

A node of type `DataTable` in a custom page:

```json
{ "type": "DataTable", "name": "customers" }
```
```json
{ "resource": "Customer", "columns": ["fullName", "email", "status", "createdAt"],
  "filters": ["status"], "pageSize": 20, "selectable": "single", "virtual": false }
```

Expansion, in `composites/data-table.ts`:

- A `useTable` call (`@refinedev/react-table`) for the resource, with server-side paging,
  sorting and filtering through Refine.
- A `columns` array built by the same snippet builders the columns tool uses
  (`packages/dev-service/src/refine/columns.ts`). The builder supplies sorters, filters by
  field type and formatted cells for enums, dates and booleans. LLD-05 exposes the generator
  interface to both callers.

  ⚑ LLD-13 puts these builders in `packages/dev-service/src/refine/`. The service injects
  the existing snippets and their imports through `CompileContext.refineSnippets` so the
  compiler can stay independent of the service.
- The refine-ui `DataTable` element, bound to the table.
- With `selectable`, the table exposes `selectedRow` (and `selectedRows` for `multiple`),
  backed by page state, so `ui.customers.selectedRow.id` works in bindings.
- With `virtual: true`, the body renders through TanStack Virtual. This applies to client-side
  row sets (`pagination: "off"`). With server paging it is ignored, with a warning.

  ⚑ The installed refine-ui DataTable accepts a table and has no configurable body slot.
  The virtual variant emits a semantic table using the same TanStack column definitions,
  virtualizes 40-pixel rows inside a scrollable region, and keeps the headers and edit
  anchors. It requires `@tanstack/react-virtual` (the fixture pins 3.14.28). The server
  paging warning is available in validation, preview and eject planning.

⚑ The table requires an explicit nonempty column list. It preserves the first occurrence of
each field, defaults to ten rows per server page, and allows filters on visible columns.
The `refine-ui` source marker resolves the installed table beside the project's UI library.

⚑ Selection uses a labelled radio or checkbox column and the contract primary key.
Single selection exposes `selectedRow`, and multiple selection also exposes `selectedRows`.
Before a selection, the row is an empty partial record so a direct field binding such as
`ui.customers.selectedRow.id` can render safely.

After eject the table is ordinary Refine code, and the columns tool adds, removes and reorders
its columns. The adapter recognizes the same `useTable` and column definitions after eject.

The DataTable manifest defers `fixedColumns`, `columnResize`, `treeRows` and `editableCells`.

## 4. `Form` (FR-KT-03)

```json
{ "resource": "Customer", "mode": "create", "fields": ["fullName", "email", "segment", "notes"],
  "layout": "grid-2", "redirect": "list" }
```

Expansion, in `composites/form.ts`:

- `useForm` from `@refinedev/react-hook-form` with `zodResolver(schema)`.
- A zod schema with a rule per field from the contract: type, enum, required-ness and bounds,
  with the messages the form-fields tool writes and later recognizes.
- Default values per field.
- One control per field in the project's form style (`Field` with `Controller`, or
  `FormField`), with the widget by type: `Input`, `Textarea` for long strings, `Select` for
  enums, `Checkbox` for booleans, `DatePicker` for dates, a password input for
  `format: password`.
- `layout` chooses the wrapper classes. `redirect` chooses where a successful save goes.

The compiler uses the builders in `packages/dev-service/src/refine/fields.ts` for rules,
defaults and controls. The form-fields tool reads the same shape and `rules.ts` aligns a
changed rule in place.

⚑ The existing Refine adapter chooses the prevailing form style and uses Field on a tie
when both installs exist. Kit date fields use the shared Calendar and Popover renderer
when those registry items are installed. The same builder supports a native date input
when they are absent. The banking fixture uses `segment` because its create contract
owns that field. Form defaults to the contract's editable scalar fields, a stacked layout
and a list redirect. Edit mode reads its record ID from the route's `:id` parameter.

A `Form` node may hold extra child nodes (a note, a custom button) in its `footer` slot.
Custom widgets per field are out: after eject they are a code edit.

## 5. Deferred (FR-KT-07)

`Tree`, `TreeSelect`, `Cascader`, `Transfer`, `Upload`, `TimePicker`, `DateRangePicker` as a
standalone input, `Steps`, `Rate`, `Tour` and `Chart`. `kit/deferred.json` lists them with a
one-line reason and the suggested route (a local component with its own manifest). A node of
such a type is `unknown_component`, with that text as the hint.

⚑ The dev service injects the published list into layer 3. Standalone manifest validation
keeps the original generic hint when a caller omits the catalog. The DataTable manifest also
provides a reason for each deferred table option at its `unknown_prop` diagnostic.

## 6. The kit fixture (FR-KT-06)

`packages/blueprint-compiler/fixtures/kit/` uses every type in the inventory, each exposed
value in a binding and each event in an action. The app under `examples/blueprint-kit/`
starts from the LLD-05 template with the registries and a mock contract.

⚑ Actions and display share one fixture page. A separate unpaged table fixture exercises
virtualization and multiple selection with 5,000 rows.

⚑ The Radix example uses shadcn CLI 4.21.3 with the `radix-nova` preset and a self-contained
snapshot of the banking OpenAPI contract, provider, and mock. The Refine registry filter
label map adds `eqs` and `nes` to match the installed Refine 5.0.12 operator union.

⚑ The second type-check uses the committed `base-nova` sources, Base UI 1.9.0, and the
parent fixture's Refine table registry. Its UI alias is distinct so the shared Refine
registry keeps its own component dependencies.

⚑ The manifest checker locates exports through the engine's `components()` result and
uses the installed TypeScript checker for inherited props and matching wrapper exports.
The engine's editor schema deliberately omits some inherited props needed by the kit.

- Unit: compile every page, compare with golden files, run `tsc`.
- e2e (`e2e/blueprint-kit.spec.ts`): eject all pages, load each route, check it renders
  without console errors, type into an input and see a bound text change, sort and filter the
  table against the mock API, submit the form.
- Coverage checks that every published manifest has a fixture page and is listed in the design.

⚑ The kit example registers the customer resource's list and create paths so Refine can
redirect a successful create to the ejected table. The Playwright project exercises the
emitted fixture through the same guarded eject routes and restores generated files and
router edits afterwards.

⚑ Generated forms name their landmarks and associate invalid controls with inline errors.
Tables provide labelled regions and native row selection controls. The installed example
table identifies the primary sort in its header and names the filter and page-size controls.
Chromium exercises Tab, Enter, Space and Escape through those controls. The accessibility
pass draws on the [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md).

## 7. Registry installation

In a Vite Refine project, install the sources into the project's chosen shadcn configuration.
The fixture uses the following registry commands.

```sh
pnpm dlx shadcn@4.21.3 add button dropdown-menu badge avatar alert tooltip skeleton breadcrumb empty \
  input textarea select checkbox switch radio-group command calendar label field card tabs dialog sheet popover separator
pnpm dlx shadcn@4.21.3 add https://ui.refine.dev/r/layout-01.json https://ui.refine.dev/r/views.json \
  https://ui.refine.dev/r/data-table.json
```

For a fresh configuration, the same CLI's `init --template vite --base radix --preset nova`
sets up the Radix base. Select `--base base` for Base UI. The Refine registry can use its own
Radix component imports in a Base UI project, as the second fixture does. Forms require
`react-hook-form`, `@hookform/resolvers` and `zod`. Calendar-backed date fields use
`date-fns` for the contract's date format. Virtual tables require `@tanstack/react-virtual`.

## 8. Open points

- React Aria as a third base once the first two are stable.
- A `DateRangePicker` input, which refine-ui has only as a table filter today.
