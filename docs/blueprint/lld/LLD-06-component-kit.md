# LLD-06: Component kit

- Spec: `specs/006-component-kit` · Requirements: FR-KT-01 to FR-KT-07 · ADR-0009, ADR-0016
- Code: `packages/blueprint-compiler/kit/` (manifest JSON, one file per type) and
  `packages/blueprint-compiler/src/composites/` (`data-table.ts`, `form.ts`).

## 1. What the kit is

The kit is data: a manifest (LLD-02) for each component a blueprint may use by name. It ships
no component source. The user's project gets the components from the shadcn registry and from
Refine's shadcn registry (refine-ui), and the manifests describe how to use what is there.

## 2. The 25 components (FR-KT-01)

| Group | Types | Registry |
| --- | --- | --- |
| Actions | `Button`, `DropdownMenu` | shadcn |
| Inputs | `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `RadioGroup`, `Combobox`, `DatePicker`, `Label`, `Field` | shadcn (`Combobox` is `popover` + `command`; `DatePicker` is `popover` + `calendar`) |
| Containers | `Card`, `Tabs`, `Dialog`, `Sheet`, `Popover`, `Separator` | shadcn |
| Display | `Badge`, `Avatar`, `Alert`, `Tooltip`, `Skeleton`, `Breadcrumb`, `Empty` | shadcn |

Plus two composites, `DataTable` and `Form`, and the HTML elements of LLD-02. Toasts are an
action step, not a node.

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

Prop names differ by shadcn base. Each manifest carries variants keyed by the project's
`components.json` style, checked against the real component source in a fixture (LLD-02
section 6). Radix and Base UI are covered first.

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
  (`src/refine/columns.ts`): a sorter header per field, the filter by field type, the cell by
  field type (a `Badge` for enums, a formatted date, Yes/No). Those builders move behind the
  generator interface of LLD-05 so both callers share them.

  ⚑ LLD-13 puts these builders in `packages/dev-service/src/refine/`. The service injects
  the existing snippets and their imports through `CompileContext.refineSnippets` so the
  compiler can stay independent of the service.
- The refine-ui `DataTable` element, bound to the table.
- With `selectable`, the table exposes `selectedRow` (and `selectedRows` for `multiple`),
  backed by page state, so `ui.customers.selectedRow.id` works in bindings.
- With `virtual: true`, the body renders through TanStack Virtual. This applies to client-side
  row sets (`pagination: "off"`). With server paging it is ignored, with a warning.

After eject the table is ordinary Refine code, and the columns tool adds, removes and reorders
its columns. That is the reason to emit this shape and no other.

Not in the first version: fixed columns, column resize, tree rows, editable cells. They are in
the manifest's `deferred` list, so validation can say so.

## 4. `Form` (FR-KT-03)

```json
{ "resource": "Customer", "mode": "create", "fields": ["fullName", "email", "status", "notes"],
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

Rule, default and control come from the builders in `src/refine/fields.ts` and `rules.ts`, so
the form-fields tool and the drift tool read back what the compiler wrote.

A `Form` node may hold extra child nodes (a note, a custom button) in its `footer` slot.
Custom widgets per field are out: after eject they are a code edit.

## 5. Deferred (FR-KT-07)

`Tree`, `TreeSelect`, `Cascader`, `Transfer`, `Upload`, `TimePicker`, `DateRangePicker` as a
standalone input, `Steps`, `Rate`, `Tour`, charts. `kit/deferred.json` lists them with a
one-line reason and the suggested route (a local component with its own manifest). A node of
such a type is `unknown_component`, with that text as the hint.

## 6. The kit fixture (FR-KT-06)

`packages/blueprint-compiler/fixtures/kit/` is a blueprint with one custom page per group,
using every type, every exposed value in a binding, and every event in an action, plus a
`DataTable` and a `Form` page. `examples/blueprint-kit/` is the app it compiles into: the
template of LLD-05 with the kit installed, on a mock contract.

⚑ The Radix example uses shadcn CLI 4.21.3 with the `radix-nova` preset and a self-contained
snapshot of the banking OpenAPI contract, provider, and mock. The Refine registry filter
label map adds `eqs` and `nes` to match the installed Refine 5.0.12 operator union.

⚑ The manifest checker locates exports through the engine's `components()` result and
uses the installed TypeScript checker for inherited props and matching wrapper exports.
The engine's editor schema deliberately omits some inherited props needed by the kit.

- Unit: compile every page, compare with golden files, run `tsc`.
- e2e (`e2e/blueprint-kit.spec.ts`): eject all pages, load each route, check it renders
  without console errors, type into an input and see a bound text change, sort and filter the
  table against the mock API, submit the form.
- A check that fails when a kit type has no page in the fixture.

## 7. Open points

- React Aria as a third base once the first two are stable.
- A `DateRangePicker` input, which refine-ui has only as a table filter today.
