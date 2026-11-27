# Engine API (contract)

`@trivia/dev-service` serves `/@trivia/api/` and calls the Rust engine through `@trivia/engine`.
On Vite, `vite-plugin-ast-locator` mounts it in the user's dev server. On Next.js,
`trivia-next dev` runs the service alongside the app on `127.0.0.1` and prints its URL.
The designer's same-origin proxy uses `TRIVIA_TARGET` for the app and `TRIVIA_API_TARGET`
for the separate service when configured. The same service also handles `/@trivia/mcp`.

TypeScript mirror of every shape: `packages/designer/src/shared/engine/types.ts`.
Rust source of truth: `crates/trivia_oxc_engine/src/{ops/mod,ops/bind_query,inspect,prop_analyzer,error}.rs`.

## Envelope

Every response is JSON: `{ "ok": true, "data": … }` or
`{ "ok": false, "error": { "code": "…", "message": "…" } }`.

HTTP status: 200 for ok. Errors: 400 `invalid_locator` `invalid_op` `invalid_snippet` `parse_error`;
403 `forbidden` (caller not on this machine, below); 404 `node_not_found` `file_not_found`; 409 `stale_locator` `conflict`;
422 `unsupported` `unresolved_component` `invalid_result` `path_outside_root`; 500 `io_error` `internal`.

Requests that change files must be `POST` with `content-type: application/json`.

The API writes to disk, so it answers only this machine. Every request under `/@trivia/api/`,
read or write, is refused with 403 `forbidden` unless all three hold:

- **Client address** is loopback: `127.0.0.0/8` or `::1`, also IPv4-mapped (`::ffff:127.0.0.1`).
  An unknown address (a Unix socket, a closed connection) is refused. This is what stops other
  machines when the dev server listens beyond loopback (`vite --host`, Docker): a non-browser
  client sends no `Origin`. The plugin option `allowRemote: true` lifts this check alone. It is
  dangerous: every client that can reach the server can then rewrite source files. The
  standalone service binds to `127.0.0.1` and always requires a loopback peer.
- **Host** (HTTP/2: `:authority`) names this machine: `localhost`, `*.localhost`, an IP literal,
  or an entry of Vite's resolved `server.allowedHosts` (`.example.com` also matches subdomains;
  `true` matches anything). These are Vite's own rules. This stops DNS rebinding, whose
  same-origin GETs carry no `Origin`. The plugin checks it itself, because Vite skips its own
  host check under `server.https`.
- **Origin**, when present, is `http(s)://` `localhost` / `127.0.0.1` / `[::1]` (any port). The
  opaque origin `null` is refused.

The designer's proxy passes all three: it connects from loopback, rewrites `Host` to the target
(`changeOrigin`), and its page's `Origin` is localhost. That hides the proxy's own client from the
plugin, so the designer makes the same three checks itself before it forwards anything under
`/@trivia/api/` (`packages/designer/server/api-guard.ts`), with the same 403 `forbidden`
envelope. A designer started with `--host` therefore still serves other machines the user's app,
but not the API. It also refuses (404) every WebSocket upgrade to `/@trivia/api/`, which has no
WebSocket endpoint. Any other proxy put in front of the dev server has to do the same.

## Endpoints

| Method | Path | Body / query | `data` |
| --- | --- | --- | --- |
| GET | `/@trivia/api/health` | — | `{ root, uiDir, importBase, version, host?: "next" }` |
| GET | `/@trivia/api/components` | — | `ComponentSchema[]` |
| GET | `/@trivia/api/inspect` | `?locator=` | `NodeDetails` |
| GET | `/@trivia/api/outline` | `?file=` (project-relative) | `OutlineNode[]` |
| GET | `/@trivia/api/routes` | — | `AppRoute[]` (the app's pages, from the source) |
| POST | `/@trivia/api/apply` | `{ op: Op, label?: string, follow?: string[] }` | `ApplyResult` |
| POST | `/@trivia/api/batch` | `{ ops: Op[], label?: string, follow?: string[] }` | `ApplyResult` (last op's locator) |
| POST | `/@trivia/api/undo` | `{}` | `HistoryResult` |
| POST | `/@trivia/api/redo` | `{}` | `HistoryResult` |
| GET | `/@trivia/api/history` | — | `HistoryState` |
| GET | `/@trivia/api/manifest` | — | `{ manifest: TriviaManifest \| null, drift: Drift \| null }` |
| GET | `/@trivia/api/selection` | — | `SelectionState` |
| POST | `/@trivia/api/selection` | `{ locator, name }` or `{ locator: null }` | `SelectionState` |
| POST | `/@trivia/api/sync` | `{ input?, zod?, force? }` | `SyncResult` |
| GET | `/@trivia/api/refine/pages` | — | `(ListPage \| FormPage)[]` (discovered Refine pages) |
| GET | `/@trivia/api/refine/page` | `?file=` | `(ListPage \| FormPage)[]` (that file's) |
| POST | `/@trivia/api/refine/columns/plan` | `{ file, component?, changes: ColumnChange[] }` | `{ ops: Op[], label, warnings? }` |
| POST | `/@trivia/api/refine/fields/plan` | `{ file, component?, changes: FieldChange[] }` | `{ ops: Op[], label, warnings? }` |
| GET | `/@trivia/api/refine/drift` | — | `{ spec: Drift \| null, pages: PageDrift[] }` |
| GET | `/@trivia/api/refine/resources` | — | `ResourcePages[]` |
| POST | `/@trivia/api/refine/pages/plan` | `{ resource, pages?: PageKind[] }` | `{ ops: Op[], label }` |
| GET | `/@trivia/api/screenshot/next` | — | `{ id: string \| null }` (long poll) |
| POST | `/@trivia/api/screenshot` | `{ id, png, width, height }` or `{ id, error }` | `null` |

- `apply` and `batch` each create **one** history entry (a batch is a transaction: if any op
  fails, files already changed by earlier ops in the batch are restored and the error returned).
  Unchanged results (`changed: false`) create no entry. A new entry clears the redo stack.
- History entries store `{ file, before, after }` per changed file. Undo writes `before` only if
  the file still equals `after` (else 409 `conflict`, history untouched). Redo uses the opposite
  guard. Source restores go through the engine's atomic, parse-validated write. Blueprint
  restores use guarded JSON snapshots in the same history. History lives in the dev-service
  process (lost on restart) and is capped at 100 entries.
- Read-after-write, on Vite: once `apply`, `batch`, `undo`, `redo` or `sync` has answered, every new
  request to the dev server gets the files as written (the plugin drops their transformed modules
  before answering). Pages already open get the change as one hot update from Vite's watcher. A
  page still loading can miss that update: Vite sends it only to the HMR sockets open at that
  moment, and its client drops one for a module that has not run yet. A canvas document catches
  up: once it has loaded and its socket has answered the plugin's `trivia:hmr-ready` probe, it
  reloads if `lastWriteAt` is at or after its start (LLD-13 §6). A plain browser tab does not,
  and no page catches up after a hand edit. The Next.js host makes no such promise.
- `ApplyResult = { file, changed, locator: string | null, history: HistoryState, followed? }`.
- `follow` (on `apply` and `batch`): locators whose node the engine follows through the edit,
  since an edit renumbers the locators after what it adds, drops or moves (rule 4).
  `followed` answers in the same order, and only when `follow` was sent. Each answer is where
  that node is now, or null when the node is gone or its place can't be known. A string that is
  not a locator is null, and so is a locator in a changed file that resolves to nothing; neither
  fails the edit.
  - The engine maps the node's byte span through the ranges the ops spliced. A splice before it
    shifts it, one after it leaves it, and one inside it (its whole span included) keeps it. A
    splice that cuts across the node or covers more than it removes it.
  - A JSX move takes the moved element's subtree along. `moveElement` takes the JSX inside the
    moved array element along, in order.
  - Every answer must be a node of the result with exactly that span, the same kind and tag,
    and (when no splice touched it) the same bytes, so a same-tag neighbour that slid into the
    old locator is never the answer.
  - A locator in a file the edit didn't change comes back as given, unchecked (the engine
    does not read files the edit left alone). `replaceFile` and `createFile` give null for
    their file. Callers check the tag at the answer, as the designer and the agent's selection
    do.
  - Undo and redo are not followed.
  - `follow` that is not an array of strings is `400 invalid_op`.
  - The binding is `applyOps(root, opsJson, followJson?)`, answering with `data.followed`. A
    native build from before it ignores `followJson`: the service then follows nothing and
    warns once to run `pnpm build:engine`.
- `HistoryResult = { files: string[], history: HistoryState }`.
- `HistoryState = { canUndo, canRedo, undoLabel: string | null, redoLabel: string | null,
  lastWriteAt: number | null }`. `lastWriteAt` is when the service last wrote the project (a
  recorded edit, an undo, a redo or a `/sync`, which is not an undo entry), in ms since the epoch
  by the service's clock, and null before its first write. An op that changes nothing, a refused
  one, a failed sync and an undo or redo with nothing to do leave it as it was. The designer
  compares it with a canvas document's load, on Next.js and on Vite, to tell whether the
  document can have missed an edit (LLD-13 §6); the service and the browser share a host.
- `manifest` is the project's `trivia.manifest.json` (`docs/data-provider.md`), null when it has
  none. `Drift = { status: "current" | "changed" | "unknown", source, manifestHash, specHash }`
  compares the manifest's `schemaHash` with contract-sync's canonical hash of the spec at
  `source.location`, so formatting alone is not drift. It is `unknown` for a URL source (not
  fetched on every request) or a spec file that is gone.
- `OutlineNode = { locator, name, line, isDirect, text?, children: OutlineNode[] }`: every JSX
  tree of the file, component by component in source order (`text` as in `NodeDetails`).
- `AppRoute = { path, params, index, catchAll, router, component, file, declared: { file, line },
  locator, resource }`: one entry per page, read from the app's source.
  - React Router: `<Route>` trees (in `<Routes>` or alone) and route objects
    (`createBrowserRouter`/`createHashRouter`/`createMemoryRouter`, `useRoutes`, also in
    `return useRoutes([...])`). A splat route's page that renders its own `<Routes>` or
    `useRoutes` has those joined onto the splat's base (`settings/*` + `profile` →
    `/settings/profile`). TanStack Router: `createFileRoute("<id>")` files and code-based
    `createRoute({ getParentRoute, path })`.
  - `router: "next-app-router"` identifies `page.tsx` and `page.jsx` modules under `app/`
    or `src/app/`. `file` and `declared.file` name the page module. Groups are omitted from
    the URL, `[id]` becomes `:id`, and `[...slug]` and `[[...slug]]` become `*`. Parallel,
    intercepted, private and preview routes are omitted.
  - `path` keeps its router's syntax (`/customers/edit/:id`, `/posts/$postId`); `params` lists
    what a URL needs (a splat is `*`). A pathless layout, and a route whose index child serves
    the same URL, are not listed; one entry per URL.
  - On Vite, `component` is the name in the route declaration, or null for a lazy route.
    `file` is the component's module as the app's imports resolve it, or null for a package.
    `locator` is the `<Route>` element's (JSX routes only). On Next, both `component` and
    `locator` are null.
  - `resource` is `{ name, action }` when `<Refine resources>` declares that path, else null.
- `SelectionState = { selection: { locator, name } | null, version, by: "designer" | "agent" | null }`:
  what the designer has selected, for agents (`docs/mcp.md`). The designer posts every change
  (`name` is the tag name it saw there). Repeating the current selection changes nothing;
  every change bumps `version`. Edits through this API never move it; an agent's edit through
  the MCP endpoint does (`by: "agent"`).
- `sync` re-runs contract-sync (`docs/data-provider.md`) in the edit queue: the spec is `input`
  (a project-relative path or URL), by default the manifest's `source.location`; the output
  directory is the manifest's `modules.outputDir` (default `src/api/generated`); `zod` defaults
  to what the manifest had (true without one). **Git guard:** when the output directory or
  the manifest has uncommitted changes (`git status --porcelain`, untracked files included),
  it is refused with 409 `conflict` naming them, unless `force: true`. Outside a git work tree
  nothing is guarded. Regeneration is not an undo entry; git is its undo.
  `SyncResult = { source, outputDir, files, schemaHash, contractChanged, resources: string[], git }`:
  `contractChanged` is false when the spec's `schemaHash` is the one the manifest already had,
  and `git` says what the guard found: `"clean"`, `"forced: replaced uncommitted changes in …"` or
  `"not a git work tree: nothing was guarded"`. A contract-sync failure is 422 `unsupported`.
- `refine/*` is the Refine adapter (`docs/product.md`, `packages/dev-service/src/refine`).
  A **list page** is a component calling `useTable` (`@refinedev/react-table`) with a `columns`
  array. `ListPage = { file, component, columnsPath, resource, rowType, contract, columns,
  available }`:
  - `columns` are as the source has them: `key` (`id`, else `accessorKey`), `label` (a string
    header or the `<span>` text of a JSX one), `filter` (the refine-ui filter component its
    header uses), `sortable`, `hasCell`, and the contract `field` it shows;
  - `available` lists the contract fields not shown yet, each with `shape`
    (`text|enum|number|date|dateTime|boolean|list|other`), `enum`, `required`, `nullable`;
  - `resource` is `refineCoreProps.resource`, else the contract resource whose `typeName` is the
    row type (`useTable<CustomerDto>`), else the page's folder name;
  - `contract` is the manifest resource it matches (by collection path segment, name, plural or
    tag).

  `ColumnChange = { action: "add", field, index?, label? } | { action: "remove", column } |
  { action: "move", column, index } | { action: "rebuild", column } | { action: "align", column }`
  (`align`: see `refine/drift` below). Changes apply in order, so a later one may name a column
  an earlier one added. The plan is value ops (`insertElement`, `removeElement`,
  `moveElement`) for the caller to apply as one entry (`/batch`), with `warnings?`. An added
  column follows Refine's shadcn examples:
  - its header gets `DataTableSorter` and a filter by type: text →
    `DataTableFilterDropdownText`, enum → `DataTableFilterCombobox` (multi, the enum's values),
    number → `DataTableFilterDropdownNumeric`, date → `DataTableFilterDropdownDateRangePicker`;
  - its cell renders by type: a `Badge` for enums, a locale date, `.toLocaleString()` for
    numbers, Yes/No for booleans, with `—` for null on nullable fields;
  - its imports come from `components.json`'s ui alias (`…/badge`) and the `refine-ui` folder
    beside it. Without refine-ui's data table, headers are plain strings.

  Refused: an unknown field (400 `invalid_op`, listing the resource's fields), a field already
  shown (409 `conflict`), an unknown column (404 `node_not_found`, listing the columns), and a
  file with no list page (404).
- A **form page** is a component calling `useForm` (`@refinedev/react-hook-form`) with
  `resolver: zodResolver(<schema>)`. Its fields are three things kept in step:
  - the schema's keys;
  - `defaultValues`;
  - a control per field: a react-hook-form `<Controller name=…>` around shadcn v4's `Field`, or
    shadcn's older `<FormField name=…>` (`FormItem`/`FormLabel`/`FormControl`/`FormMessage`), as
    Refine's docs and registry write it.

  The schema is found through a schema-level `.refine(…)` (`z.object({…}).refine(…)`) too.

  `FormPage = { file, component, action, resource, contract, schemaPath, defaultsPath, fields,
  style, provider, available, container }`:
  - `action` is `refineCoreProps.action`, else the file name (`create.tsx`, `edit.tsx`);
  - `contract` is the request body it sends (`create` for a create form, `update` for an edit);
  - each field has:
    - its `label` (the `<FieldLabel>` or `<FormLabel>` text) and `widget` (`Input`, `Select`…);
    - `rule` (its zod rule as written), `ruleChain` (the rule's calls) and `ruleLine`;
    - `hasDefault`, and the body `field`;
    - `control`: `{ locator, line, element, direct, parent }`. `element` is `Controller` or
      `FormField`, and `direct` is false under a `{cond && …}` guard;
  - `style` is the style its controls use (`field` or `form`; null when it has none), and
    `provider` says a `<Form>` encloses its `<form>`;
  - `available` lists the body's writable fields the form lacks.

  `FieldChange = { action: "add", field, index?, label? } | { action: "remove", field } |
  { action: "move", field, index } | { action: "rebuild", field } | { action: "align", field }`
  (`align`: see `refine/drift` below). A plan is `{ ops, label, warnings? }`. The changes in one plan are
  tracked by index-path prefix: each insert, removal or move renumbers the elements after it and
  everything inside them, so one plan can change fields in different wrappers. An added field is:
  - `setProperty` on the schema with its rule: `z.enum([…])`, `z.number()` (`.int()` for
    integers), `z.boolean()`, `z.iso.date()`, `z.email()`, `z.string().min(1, "Required.")`, …,
    then the bounds the contract declares (`constraints`):
    - `.min(n, "Enter at least n characters.")` and `.max(…)` for text;
    - `.regex(new RegExp("…"), …)` for a pattern JavaScript can compile;
    - `.min`/`.max`/`.gt`/`.lt` for numbers;
    - then `.nullable()` and `.optional()` from the contract;
  - `setProperty` on `defaultValues`: the spec's default, else `""`, the first enum value, `0` or
    `false` for a required field, and `undefined` for an optional one;
  - an `insert` of its control, in its form's style. An empty form takes the style most of the
    project's forms use; with none, `ui/field.tsx` means `Field`, else `ui/form.tsx` means
    `FormField`. `FormField` is used only when a `<Form>` provider is there.
    - With an `index`, it goes before the `index`-th field, or after the last.
    - Without one, it goes after the nearest field before it in the contract's order, inside
      that field's wrapper. Failing that, before the nearest one after it, else after the last.
      A guarded field is never the anchor.
    - A rebuilt field goes back into the slot it came from.

    The widget is a
    `Select` for an enum, a number input, a date input, a `Checkbox` for a boolean, a
    `Textarea` for text with `maxLength` over 255 (when the project has `ui/textarea.tsx`), a
    password input for `format: password`, else a text input. Its empty value is absent when the
    field is optional.

  A removal drops all three (and imports only it used). A move moves the control.
- `refine/drift` is contract drift (`docs/product.md`, slice 3): where the Refine pages no longer
  match the manifest. `spec` is the `/manifest` drift: when it says `changed`, sync first.
  `PageDrift = { file, component, kind, issues }`, each issue `{ code, name, message, line, fix,
  references? }`:
  - `missing_field`: a column with an accessor, or a form field, names a field the entity or
    request body no longer has. Fix: remove it. For a form, `references` lists the other lines
    of the file that still name it (`values.email` in a `.refine`, `watch("email")`, a key, a
    destructured `{ email }`), from the engine's `mentions`. The field's own schema key, default
    and `name="…"` are left out. They break when the field goes, so the plan that removes it
    returns them as `warnings`.
  - `enum_changed`: the values a page writes for an enum differ, as a set, from the
    contract's (order alone is not drift). They are read where the page writes them (a
    **site**), whole, by value path or locator:
    - a column's `DataTableFilterCombobox options={[…]}`
      (`<column path>.header<DataTableFilterCombobox>.options`);
    - a form field's `z.enum([…])` array (`<schemaPath>.<field>`);
    - the `<SelectItem value="…">`s inside the field's control.

    Each site is in one of four states, the same for drift and for the plan that fixes it:
    - `absent`: there is no such place (no rule, no control, a header without a Combobox);
    - `literal`: plain string values, each written once. It is compared, and edited;
    - `blocked`: plain strings that can't be edited one by one (a value written twice, a
      `<SelectItem>` under a `{…}` guard, an array value with a `]`, which a path step can't
      name). It is compared, and when it is stale the fix is a rebuild;
    - `opaque`: written some other way (`z.enum(STATUSES)`, `[...BASE, "x"]`,
      `options={statusOptions}`, a `.map(…)`, a control with no `<SelectItem>`, two Comboboxes
      in one header). It gives no verdict and is never edited. Trivia does not follow a
      constant: other code may share it.

    Fix: `{ action: "align", column }` or `{ action: "align", field }`, or a rebuild when a
    stale site is blocked. `references` lists the other lines that still name a removed value
    as a string or an object key (`values.status === "suspended"`, `{ suspended: "…" }`), and
    the message ends `; the file still names "suspended" on line 37`. The options themselves
    and a default the fix rewrites are left out.
  - `type_changed`: a column's filter, or a field's zod rule, belongs to another type than the
    field now has. Fix: rebuild it in place.
  - `required_missing`: a create form lacks a field its body now requires. Fix: add it.
  - `constraint_changed`: a field's rule has another bound than the contract states, or none:
    `min`/`max` for text length, `regex` for a pattern, `min`/`max`/`gt`/`lt` for numbers.
    A bound only the rule has is not drift: it may be deliberate.
  - `optionality_changed`: the rule is `.optional()` (or `.nullish()`) for a field the contract
    now requires, or `.nullable()` for one it no longer lets be null. A rule stricter than the
    contract is not drift.

  Both are fixed by `{ action: "align", field }`. It edits the rule in place with chain ops, so
  custom calls (`.refine(…)`, `.transform(…)`) and the developer's messages stay. A differing
  bound's argument is set (`setCallArgument`), and a missing one is inserted before the
  modifiers (`insertCall`, before `.optional()`, `.refine(…)`, …). `.optional()` and `.nullable()`
  are removed (`removeCall`). A message that names the old bound exactly once gets the new one
  (`"At most 100 characters"` → `"At most 500 characters"`), and Trivia's own "Required." becomes
  the new minimum's message. Aligning a rule that already matches is 409 `conflict`.

  The same `align` fixes `enum_changed`, on a column too (`{ action: "align", column }`). It
  adds and removes single options at each literal site and touches nothing else: kept options
  keep their labels, quotes, extra properties (`{ label: t("…"), value: "active", icon }`) and
  position. One `align` on a field settles its options, its default and its rule.
  - A new value goes after the nearest value before it in the contract that the site has,
    else before the nearest one after it, else after the last item, so the page's order
    stays. It is written as the generators write it: `"closed"` in the rule
    (`insertElement`), `{ label: "Closed", value: "closed" }` in the options, and
    `<SelectItem value="closed">Closed</SelectItem>` beside its anchor item (`insert`). The
    label is the value humanized; a `t(…)` style is the developer's to finish.
  - A removed value goes with its label: `removeElement` at `<rule path>[=suspended]` or
    `<options path>[value=suspended]`, and `remove` of its `<SelectItem>`. The items' locators
    are tracked through the plan like the controls', so each op names the item it means.
  - A `defaultValues.<field>` that is a removed value becomes the generator's default: the
    spec's default, `undefined` for an optional field, else the first value.
  - The plan's `warnings` name the code that still uses a removed value, and each opaque site
    it left as written next to a literal one (``the Status rule `z.enum(STATUSES)` is not a
    literal list, so it was left as written``).
  - Refused: a stale blocked site (422 `unsupported`, saying to rebuild instead), a column
    whose options are opaque or missing (422), options that already match the contract (409
    `conflict`), and a column or field that an earlier change in the same plan added,
    removed, rebuilt or aligned (409: its sites were read before that change).
  - Labels: `Update the Status filter options from the contract` (a column),
    `Update the Status options from the contract` (a field whose options changed; its rule
    issues share that fix), `Update the Status rule from the contract` (a field whose options
    match).

  `fix = { label, changes }` takes column changes (list) or field changes (form) for the plan
  routes above. A rebuild (`{ action: "rebuild", column | field }`) is resolved where the item is
  when it is planned, as a remove plus an add at that index with the same label, and an align
  reads its sites when it is planned. So a fix read before another fix ran still lands in the
  right place: a removal names its key, an added field appends, and an option is named by its
  value. A rebuild takes the generated shape (custom cells, widgets and messages in the item
  are replaced), so it is the fix only for `type_changed` and blocked option sites.
- `refine/resources` and `refine/pages/plan` add pages (`docs/product.md`, slice 4).
  `ResourcePages = { resource, name, existing, possible }` for each contract resource:
  - `name` is its Refine name (the collection path's last segment);
  - `existing` are the page kinds its `<Refine resources>` entry registers;
  - `possible` are the kinds its operations support: `list` (list), `create` (create with a
    body), `edit` (update with a body), `show` (get).

  The app's Refine registration is the file that renders `<Refine resources={[…]}>`. A plan for `resource`
  (manifest or Refine name) adds the `pages` kinds asked for, by default every possible one it
  lacks:
  - one `createFile` per page. On Vite it goes beside the existing list pages as
    `<pagesDir>/<name>/<kind>.tsx`, defaulting to `src/pages`. On Next it goes under the App
    Router directory as a client `page.tsx`, using the resource's route group when available.
    The page uses the same column and form generators on both hosts.
    - a list: `useTable`, columns for up to six scalar fields (as slice 1 writes them), and an
      Edit/Show actions column;
    - create and edit: a zod schema, `useForm` and a Controller per scalar body field (as
      slice 2 writes them);
    - show: `useShow` and a `<dl>` of every field.
  - `setProperty` on the resource's entry (`<Refine>.resources[name=…]`) for each new route
    (`/name`, `/name/create`, `/name/edit/:id`, `/name/show/:id`), or an `insertElement` of a
    new entry;
  - on Vite, an `insert` of each `<Route path element>`, before the catch-all `<Route path="*">`
    beside the resource routes (else after the last of them), with the page's import. On
    Next, the file registers the route.

  It is one undo entry, and undo deletes the files. Refused: an unknown resource (404), a kind
  its contract can't support (422), a page it already has or an existing file (409; nothing is
  overwritten), and an app without `<Refine resources>` (422).
- `refine/preview` and `refine/eject` serve `@trivia/openapi-inferencer` (`docs/product.md`,
  slice 6). Both take `{ resource, kind, hide?, title?, file? }`: a manifest or Refine resource
  name, a page kind, fields to leave out, the header's title, and where eject writes the page
  (under `src/`, default as `refine/pages/plan` would).
  - `refine/preview` answers `InferredPage = { resource, name, kind, component, importPath,
    file, exists, route, module, code }`.
    - `code` is what `refine/pages/plan` would write for that page, from the contract alone.
    - On Vite, `module` (`/@trivia/preview/<id>.tsx`) is the same code as a module of the app's dev
      server, generated afresh on each load. Vite compiles it like a file of the project's
      `src/`, with its aliases, components and React refresh, so the inferencer imports and
      renders it. Its elements get no locators: they belong to no file yet.
    - On Vite, a manifest change invalidates previews and reloads the page.
    - With Vite and Tailwind v4 (a CSS under `src/` that imports `"tailwindcss"`), the module also
      imports `/@trivia/preview/<id>.css`. That stylesheet `@reference`s the app's entry CSS and
      emits the utilities the page's `className`s need. Tailwind only finds classes in files on
      disk, so without it the preview would miss the ones no file uses yet. That import is the
      only line the module has beyond `code`.
    - On Next, `module` is an App Router preview URL under `/__blueprint/`. The host writes
      `code` to the preview group and removes those files on launcher shutdown.
  - `refine/eject` also takes `locator`, the inferencer element's own locator, and returns a plan:
    - a `createFile` of `code`;
    - a `replaceElement` that puts `<Component />` and its import where the inferencer was.
    - Without a locator, it returns the `createFile`, with a swap warning for Vite callers.
    - Refused: an existing file (409; pass another `file`), an unknown resource (404), a kind
      the contract can't support (422).

  Agents use `trivia_add_pages`, which writes and routes pages without an inferencer: there is
  no MCP tool for these two.
- `screenshot/next` and `screenshot` are the designer's half of the MCP `trivia_screenshot` tool
  (`docs/mcp.md`). The plugin has no browser, so the open designer holds a long poll on
  `screenshot/next` (`id: null` after 25 s with no request) and answers each id it gets with
  a PNG of the canvas (base64; a `data:image/png;base64,` prefix is stripped) or why it couldn't
  take one. A poll whose caller hangs up is dropped at once, so a closed designer tab never
  takes a request. `screenshot` accepts bodies up to 24 MB; an id nobody is waiting for any more
  is 400 `invalid_op`.

## Ops (`Op`, tagged by `op`)

```jsonc
{ "op": "insert", "target": "<loc>", "expectedName": "CardContent", "placement": "before|after|firstChild|lastChild",
  "snippet": "<Button variant=\"destructive\">Delete</Button>",
  "imports": [{ "name": "Button", "source": "@/components/ui/button" }] }
{ "op": "insertChild", "parent": "<loc>", "expectedName": "CardContent", "index": 2, "snippet": "…", "imports": [] }
{ "op": "updateProp", "target": "<loc>", "expectedName": "Button", "prop": "variant", "value": "outline" }
{ "op": "remove", "target": "<loc>", "expectedName": "Button" }
{ "op": "move", "source": "<loc>", "expectedName": "Button", "target": "<loc>", "expectedTargetName": "CardFooter",
  "placement": "before" }
{ "op": "moveNode", "source": "<loc>", "expectedName": "Button", "parent": "<loc>", "expectedParentName": "CardFooter",
  "index": 0 }
{ "op": "bindQuery", "target": "<loc>", "expectedName": "DataTable",
  "optionsFn": "listCustomersOptions", "optionsImport": "@/api/generated/@tanstack/react-query.gen",
  "optionsArgs": "{ query: { page: 1, pageSize: 20 } }", "resource": "Customer",
  "itemsPath": "items", "dataProp": "data", "loadingProp": "isLoading" }
{ "op": "setText", "target": "<loc>", "expectedName": "Button", "text": "Save changes" }
{ "op": "createFile", "file": "src/components/forms/customer-form.tsx", "content": "export function CustomerForm() {…}" }
{ "op": "insertElement", "path": "src/pages/customers/list.tsx#CustomerList#columns", "index": 2, "value": "{ id: \"segment\", accessorKey: \"segment\", header: \"Segment\" }", "imports": [] }
{ "op": "removeElement", "path": "src/pages/customers/list.tsx#CustomerList#columns[id=segment]" }
{ "op": "moveElement", "path": "src/pages/customers/list.tsx#CustomerList#columns[id=segment]", "index": 0 }
{ "op": "setProperty", "path": "src/pages/customers/list.tsx#CustomerList#columns[id=email]", "prop": "enableSorting", "value": "false", "imports": [] }
{ "op": "removeProperty", "path": "src/pages/customers/list.tsx#CustomerList#columns[id=email]", "prop": "enableSorting" }
{ "op": "replaceElement", "target": "<loc>", "expectedName": "OpenApiListInferencer", "snippet": "<TransactionList />", "imports": [{ "name": "TransactionList", "source": "@/pages/transactions/list" }] }
{ "op": "setCallArgument", "path": "src/pages/customers/edit.tsx#module#customerSchema.notes", "method": "max", "index": 0, "value": "500" }
{ "op": "insertCall", "path": "src/pages/customers/edit.tsx#module#customerSchema.fullName", "call": "max(120, \"Enter at most 120 characters.\")", "before": ["optional", "refine"] }
{ "op": "removeCall", "path": "src/pages/customers/edit.tsx#module#customerSchema.phone", "method": "optional" }
{ "op": "replaceFile", "file": "src/pages/summary/Summary.tsx",
  "expectedHash": "sha256:8ee4edc1ba342472bcd80bb951ce4df7ff1124d8c79a36086ba55fa1af1da1cf",
  "content": "export const Summary = () => <main>Summary</main>\n" }
```

- `value: null` removes the prop. Strings become `"…"` attributes; booleans, numbers, arrays
  and objects become `{…}` expressions. `true` on a bare shorthand attribute is a no-op.
  An existing attribute keeps its form: a `'…'` string keeps its quote (a character JSX can't
  hold raw is written as a reference, e.g. `&quot;`), `{'…'}` / `` {`…`} `` keep their literal
  kind, other `{…}` values keep their braces. Setting the value a prop already has is a no-op
  (`changed: false`). `null` removes every occurrence of a duplicated prop.
- `setText` replaces an element's plain-text content (`text` is the string React renders).
  Line breaks and indentation around the text are layout and stay as written; whitespace on
  the text's own line is content. `{`, `}`, `<`, `>` are written as character references (and
  `&` as `&amp;` only when it would otherwise decode). A self-closing element is opened
  (`<Badge />` → `<Badge>New</Badge>`). Refused: content other than plain text (422
  `unsupported`: elements, `{…}` expressions, comments), void HTML elements (422), a line
  break in `text`, and text that would render differently where it goes, such as spaces next
  to a line break (400 `invalid_op`). The text it already has is a no-op (`changed: false`).
- `createFile` writes a new `.tsx`, `.jsx` or `.ts` file inside the root, making its directories. It
  is refused when the file exists (409 `conflict`; it never overwrites; with `"ifMissing": true`
  an existing file is kept as it is and the op is a no-op) and when `content`
  doesn't parse (422 `invalid_result`). In a history entry the file's `before` is `null`, so
  undo deletes it (only if it still holds what was written) and redo writes it again. The
  binding's `restoreFiles` takes `expected: null` (must not exist) and `content: null` (delete).
- `replaceFile` writes the full source of a previously generated `.tsx`, `.jsx` or `.ts` file.
  The expected hash is lowercase SHA-256 of the original bytes, prefixed with `sha256:`.
  The op returns 404 `file_not_found` if the target is missing, 409 `conflict` if the hash
  differs, or 400 `parse_error` if either version fails to parse. Undo can restore the
  original bytes, including line endings. An identical replacement creates no history entry.
- **Value ops** (`insertElement`, `removeElement`, `moveElement`, `setProperty`,
  `removeProperty`) edit object and array literals rather than JSX. They address them by
  **value path** `<file>#<scope>#<head><step>*` (`crate::values`):
  - `scope` is a top-level function named as locators name it, or `module`;
  - `head` is a binding at the top of that scope's body (`columns`), its first call to a
    function (`useForm()`), or its first JSX element with a tag name, followed by an attribute
    (`<Refine>.resources`: the expression in `resources={…}`);
  - steps are `.prop`, `[key=value]` (the element that is an object whose `key` is that string),
    `[=value]` (the element that is that string: `customerSchema.status[=suspended]`), `[i]`,
    and `<Tag>.attr`: the expression in `attr={…}` of the one `<Tag>` element inside the value
    as written, wherever it sits in it
    (`columns[id=status].header<DataTableFilterCombobox>.options`, a header with a block body
    or a conditional too). No such element is 404 `node_not_found`; two are 422 `unsupported`.
    The head form `<Refine>.resources` takes the scope's first one.

  On the way, values unwrap to the literal they hold: parentheses and TS `as`/`satisfies`/`!`,
  a function to what it returns, a call to its first argument. A method chain whose first call
  holds a literal unwraps to that literal. So `columns` reaches the array in
  `useMemo(() => [...], [])`, and `schema` the object in `z.object({…}).refine(…)`. A new
  `setProperty` key goes before trailing spreads (`{ name: "", ...defaults }`), so they still
  override it. `value` is source text for one expression; its imports work as a
  snippet's do. Layout follows the literal (one item per line with or without a trailing
  comma, or one line), and inserting then removing an item, or moving it there and back,
  restores the bytes. Keyed paths are their own stale guard: a missing key is 404
  `node_not_found`, and a key two elements share is 422 `unsupported`. `removeElement` and
  `removeProperty` drop imports only the removed code used. `locator` in the result is `null`.
- `replaceElement` swaps the element at `target` for `snippet` (one JSX element) where it
  stands, also inside a `{…}` expression or an attribute value (`element={<X />}`), where
  siblings can't be added. Its `imports` work as an insert's do, and the old element's imports
  go when it was their last use. `locator` in the result is the new element's: it keeps the old
  one's place.
- **Chain ops** (`setCallArgument`, `insertCall`, `removeCall`) edit one call of the method chain
  at a value path, such as a zod rule `z.string().max(100, "…").optional()`. The other calls,
  and the developer's messages, stay as written.
  - `method` names a call after the first by its method (`max`), and the first by its callee
    (`z.string`, `z.enum`). A chain that calls it twice is 422 `unsupported`.
  - `setCallArgument` replaces argument `index`, or appends one when `index` is the argument
    count.
  - `insertCall` adds `call` (one method call: `max(500)`) before the first call named in
    `before`, else at the end. It takes the chain's layout: a line of its own when the calls
    around it have one, else inline.
  - `removeCall` drops a call (not the first) and the imports only it used.
  - Inserting and then removing a call restores the bytes. A path that holds no call is 422
    `unsupported`.
- `NodeDetails` reports runtime values: `attributes[].value` and `text` have HTML character
  references decoded (`"a &amp; b"` → `a & b`) and `text` follows JSX whitespace rules;
  `attributes[].source` is the text as written.
- Stale-locator guards (optional, recommended): the tag name the caller saw at each locator
  the op names: `expectedName` for `target` (`insert`, `updateProp`, `setText`, `remove`, `bindQuery`),
  for `parent` (`insertChild`) and for `source` (`move`, `moveNode`); `expectedTargetName` for
  a move's `target`; `expectedParentName` for a `moveNode`'s `parent`. When the locator now
  resolves to a different tag (a hand edit shifted it), the op fails with 409 `stale_locator`
  instead of editing the wrong node. Fragments are named `<>`.
- Unknown fields are rejected with 400 `invalid_op`, on every op, on `imports` entries and on
  `bindQuery`'s fields, so a misspelled guard (`expectedname`) is an error, never silently no
  guard.
- `index` counts the parent's JSX children (same numbering as locator segments) **before** the
  op. `index == children.length` appends.
- Snippets must be exactly one JSX element/fragment. Every component it uses must already be
  bound in the file or listed in `imports`, else 422 `unresolved_component`.
  Nothing may surround the element (a comment or wrapping parentheses would become JSX text):
  400 `invalid_snippet`. `imports` the snippet doesn't reference are ignored; a name bound only
  as a type (`import type`) is refused with 422 `unsupported`.
- An `imports` entry whose name the file already binds is reused only when that binding is the
  requested import (a value import of that name, or `import X` / `{ default as X }` for
  `"default": true`, from the same module). Anything else — another module
  (`import { Button } from "@mui/material"`), a local declaration, a local that shadows the
  name where the element lands — is 422 `unsupported`, naming the binding: the element would
  otherwise render that other thing.
- Two `source`s are the same module when they are equal, or when both name a path in the
  project and the paths match: relative specifiers are read against the edited file's
  directory, `@/…` and `~/…` mean `src/…` (the shadcn `components.json` convention, tsconfig
  `"@/*": ["./src/*"]`), and a `.ts` `.tsx` `.js` `.jsx` `.mjs` extension and a trailing
  `/index` are dropped. In `src/pages/Page.tsx`, `"../components/ui/button"`,
  `"@/components/ui/button.tsx"` and `"../components/ui/button/index"` are all
  `"@/components/ui/button"`. Bare package names (`"@mui/material"`) must match exactly, and a
  path that climbs out of the project only matches the same text. Nothing is resolved on disk,
  so a project that maps `@/` elsewhere only loses reuse (its other spellings are refused).
  A missing specifier joins the file's value import of the same module, in the file's spelling.
  `bindQuery`'s `useQuery` and factory imports follow the same rules.
- Snippets are checked before parsing: at most 4096 bytes (after trimming surrounding
  whitespace), at most 256 levels of nesting (elements, `{…}`, `(…)`, `[…]`, `{…}`, template
  substitutions) and at most 1024 tags and brackets (`<`, `(`, `[`, `{`, counted anywhere) in
  total; beyond that, 400 `invalid_snippet`. (The parser and the passes after it recurse once
  per level, and operator chains such as `!!!!x`, `x + x + …` or `a ? b : …` nest without a
  bracket. With these limits the worst accepted snippet needs about 5 MB of stack in a debug
  build, and much less in release, so it fits an 8 MiB main thread:
  `crates/trivia_oxc_engine/tests/stack_budget.rs`. 16 KiB of `!` would need about 20 MB.)
- A user file whose locators would hold more than 2^22 (4 194 304) index segments in all is
  422 `unsupported` on every endpoint that reads it, and the plugin serves it without locators
  (with a warning). A locator is as long as its element's depth, so the total grows with the
  square of the nesting: 50 000 nested elements took more than 6 GB. A single chain reaches the
  limit about 2 900 elements deep. Of 1 036 real files measured, the largest held 1 448 and the
  deepest nested 14 levels. Each top-level component numbers its own roots, so moving deep
  markup into components of its own lowers the count.
- A `move` or `moveNode` whose destination is in another file edits both files, as one
  transaction and one undo entry (through `apply`/`batch`; the binding's single-op `applyOp`
  refuses it). The element's bytes move as within a file. Each name it imports comes along:
  the destination gets the same import, merged into one it already has, with a relative source
  rewritten for its directory. The source file drops imports that nothing uses any more.
  Refused with 422 `unsupported`, naming the identifier: anything the other file can't see
  (a prop, a local, a module-level declaration, `this`), an import under another name
  (`{ a as b }`) or a namespace import, and a global the destination declares locally where
  it lands. `ApplyResult.file` and `locator` are the destination's.
- A `move`/`moveNode` must not change what the moved code refers to: every identifier it uses
  but does not declare must resolve to the same binding where it lands, or stay a global
  there, and `this` must keep its function. Moving `<span>{item.name}</span>` out of
  `items.map((item) => …)`, or `<b>{label}</b>` into another component of the file (with or
  without its own `label`), is 422 `unsupported`, naming the identifier. Module-level names
  (imports, top-level constants) and static JSX move freely between components.
- `bindQuery` writes `const { data: customerData, isLoading: isCustomerLoading } = useQuery({ ...listCustomersOptions(…) })`
  as the first statement of the element's component, imports `useQuery` and the factory, and sets
  `data={customerData?.items ?? []}` / `isLoading={isCustomerLoading}`. When `optionsArgs` reads the component's
  own locals (`{ path: { id } }` after `const { id } = useParams()`), the hook goes right after the last statement
  declaring one of them; 422 `unsupported` when that would follow an early `return` (rules of hooks) or the
  element itself. The names `optionsArgs` reads must mean at the component's top level what they mean at the
  element: one the element sees as a binding of a nested function or block (`ids.map((id) => <DataTable />)`)
  is 422 `unsupported`; a name that is a global where the element is stays a global, even when an unrelated
  nested scope declares the same name. A component local or parameter the args read that is assigned again
  after its declaration (`let id = ""; try { id = … } catch {}`, `page++` in a callback, a second `var id`) is
  422 `unsupported` as well: the hook would only ever see its first value. `optionsArgs` is one expression, at
  most 4096 bytes, nested at most 256 levels deep and with at most 1024 brackets and tags (else 400
  `invalid_op`). It is idempotent (re-binding returns
  `changed: false`). Rules and refusals: `crates/trivia_oxc_engine/src/ops/bind_query.rs`; design: `docs/data-provider.md`. Moving a node into itself or its own subtree
  is 400 `invalid_op`.
- The engine's guarded write (undo/redo `restore`) itself answers `conflict` when the file no
  longer has the expected content.

## Locators

`<file>#<component>#<i.j.k>` — e.g. `src/pages/Dashboard.tsx#Dashboard#0.0.1`. The rules are
documented once, in `crates/trivia_oxc_engine/src/locator.rs`. Key consequences for the designer:

- Locators are **positions**, not identities. After any edit, use the `locator` returned by the
  op, and re-read `data-ast-node` from the DOM after HMR.
- Several DOM nodes can share one locator (elements rendered by `.map()`): highlight all.
- The plugin also annotates the component library (`uiDir`, default `src/components/ui`). Those
  definition-site locators are not what the user wants to edit: selection climbs to the nearest
  ancestor whose locator file is outside `uiDir` (component boundary).
- Nodes rendered inside `{…}` expressions (`isDirect: false`) and component roots (`isRoot`)
  cannot be moved/removed/used as before/after anchors; the engine answers 422 with a message.

## Blueprint

Vite and Next.js serve the blueprint read and patch API, and both preview and eject (spec
012): Vite Refine through a virtual module, Next.js App Router (`targets.web = next-refine`) through
compiled files the dev service writes under `app/(blueprint-preview)/%5F_blueprint/<Name>/`
(LLD-12). Document paths are relative to the blueprint directory, which defaults to
`blueprint` and is configurable on Vite. The emitted `files` and source operations in an
eject plan use project-relative paths.
`dir` in the summary is relative to the project root. Blueprint endpoints require loopback even with Vite's
`allowRemote: true`. Paths that traverse outside the blueprint directory or contain
symlinks return 422 `path_outside_root`.

`GET /@trivia/api/blueprint` returns `{ dir, exists, app, model, pages, diagnostics, next }`.
`model` contains the model revision and entity names when a valid model exists.
A missing directory still returns 200 with `exists: false` and a suggested first op. Each
page has `name, path, rev, route, kind, status, errors, warnings`. A page in the lock also
has a project-relative `file`. Its status is `ejected` when that file's bytes match the lock
and `edited` when they differ or the file is missing. Pages absent from the lock are `draft`.

```http
GET /@trivia/api/blueprint
```

`GET /@trivia/api/blueprint/doc` returns `{ path, rev, doc, projection? }`. Pass
`projection=1` to include the lossy TSX projection of a page. A missing document returns
404 `node_not_found`, and an unsupported version returns 422 `unsupported` with
`error.details.found` and `error.details.supported`.

```http
GET /@trivia/api/blueprint/doc?path=pages%2FCustomers.page.json&projection=1
```

`GET /@trivia/api/blueprint/components` returns `{ components, schemas }`. Each index entry
has its type, slots, events, exposed values and installation status. `schemas` maps the same
type names to JSON Schemas for their props.

```http
GET /@trivia/api/blueprint/components
```

`POST /@trivia/api/blueprint/patch` accepts `{ ops, label }`. Each op names a `doc` and its
`baseRev` from a read, or `null` when the document must be absent. A successful response
contains `{ changed, revs, created, diagnostics, entry, summary }`. `entry` is the undo label,
or `null` when the patch changes no bytes. Use `summary.next` with the diagnostics.
Manifest, contract and expression errors can be saved in a draft. A patch that introduces a
schema or reference error returns 422 `invalid_result` without writing.

```http
POST /@trivia/api/blueprint/patch
Content-Type: application/json

{"label":"Add customers","ops":[{"op":"createPage","doc":"pages/Customers.page.json","baseRev":null,"name":"Customers","route":"/customer-workbench","kind":"custom"}]}
```

A document from an unsupported version gives the same 422 error on a patch against
its current revision as on a document read.

A stale revision or a file changed between planning and writing returns 409 `conflict`
with `error.details.revs`. The map contains the current revision of each affected
document, with `null` for a missing document. Re-read the affected documents before retrying.

`preview` takes the page name and returns `{ page, route, module, code, requires, diagnostics }`.
Load `route` in the canvas of a running Vite Refine app. The app loads `module` at
`/@trivia/preview/<id>.tsx`. Reload the route to see the current draft. An invalid page returns
422 `invalid_result` with `error.details.diagnostics`.

```http
POST /@trivia/api/blueprint/preview
Content-Type: application/json

{"page":"Customers"}
```

`plan` accepts optional `pages` and defaults to all drafts. It returns
`{ ops, files, requires, warnings, lock, label }`. Review the operations and warnings before
applying them. A file changed since eject or a foreign file or route returns 409 `conflict`.
Missing components return 422 `unresolved_component` with `error.details.requires` listing
the registry items to install.

```http
POST /@trivia/api/blueprint/plan
Content-Type: application/json

{"pages":["Customers"]}
```

Apply `{ ops, label }` as returned with `POST /@trivia/api/batch`. The final
operation creates or replaces the managed `blueprint.lock.json` inside the blueprint
directory. The draft revisions are checked before the batch writes any files. Source,
registrations and the lock share an undo entry. `ejected` verifies the latest entry and
checks that its lock still matches and includes the requested pages. It returns `{ lockRev }`.

```http
POST /@trivia/api/blueprint/ejected
Content-Type: application/json

{"pages":["Customers"],"entry":"Eject Customers"}
```

`backend` runs `trivia-dotnet` for the project's blueprint and solution root. Install the
.NET 10 SDK and put the .NET tool on `PATH`. `mode: "plan"` reports proposed files and
diagnostics. `mode: "write"` applies the generation plan. Set `force: true` on a write to
allow replacement or removal of modified generated files. A write-mode request with
`migration` generates the API and then adds that named EF migration in the same call. It
stops before the migration when generation is refused. After a successful migration, the
service clears the `renamedFrom` markers the migration settled, as one undo entry. When it
cannot clear them because the model changed meanwhile, it answers 409 `conflict` with
`error.details.migration`, `renames` and `markers`; the migration stays. A rename that would
drop data refuses the migration with diagnostics and leaves no migration behind.

The result is `{ files, written, diagnostics, log, renames?, next? }`. `renames` lists the
table and column renames a migration made for `renamedFrom` markers. After a successful write
or migration, `next` gives the build command and working directory, then the MCP calls
for contract sync and drift. Each file has a `path`, `kind` and
`action`, including `delete` for retired generated files and `refused` for blocked writes.
`written` is true when the CLI successfully changes at least one file. The log holds
bounded stderr. The CLI owns the backend file plan. If the SDK or tool is unavailable,
the API returns 422 `unsupported` with `error.details.hint`.

```http
POST /@trivia/api/blueprint/backend
Content-Type: application/json

{"mode":"plan"}
```
