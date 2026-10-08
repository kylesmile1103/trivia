# Engine API (contract)

The designer talks to the engine over HTTP. `vite-plugin-ast-locator` serves these endpoints
from the **user's** Vite dev server under `/@trivia/api/`, calling the Rust engine through the
napi binding (`@trivia/engine`). The designer reaches them through its same-origin proxy.

TypeScript mirror of every shape: `packages/designer/src/shared/engine/types.ts`.
Rust source of truth: `crates/trivia_oxc_engine/src/{ops/mod,ops/bind_query,inspect,prop_analyzer,error}.rs`.

## Envelope

Every response is JSON: `{ "ok": true, "data": … }` or
`{ "ok": false, "error": { "code": "…", "message": "…" } }`.

HTTP status: 200 for ok. Errors: 400 `invalid_locator` `invalid_op` `invalid_snippet` `parse_error`;
403 `forbidden` (caller not on this machine, below); 404 `node_not_found`; 409 `stale_locator` `conflict`;
422 `unsupported` `unresolved_component` `invalid_result` `path_outside_root`; 500 `io_error` `internal`.

Requests that change files must be `POST` with `content-type: application/json`.

The API writes to disk, so it answers only this machine. Every request under `/@trivia/api/`,
read or write, is refused with 403 `forbidden` unless all three hold:

- **Client address** is loopback: `127.0.0.0/8` or `::1`, also IPv4-mapped (`::ffff:127.0.0.1`).
  An unknown address (a Unix socket, a closed connection) is refused. This is what stops other
  machines when the dev server listens beyond loopback (`vite --host`, Docker): a non-browser
  client sends no `Origin`. The plugin option `allowRemote: true` lifts this check alone. It is
  dangerous: every client that can reach the server can then rewrite source files.
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
| GET | `/@trivia/api/health` | — | `{ root, uiDir, importBase, version }` |
| GET | `/@trivia/api/components` | — | `ComponentSchema[]` |
| GET | `/@trivia/api/inspect` | `?locator=` | `NodeDetails` |
| GET | `/@trivia/api/outline` | `?file=` (project-relative) | `OutlineNode[]` |
| POST | `/@trivia/api/apply` | `{ op: Op, label?: string }` | `ApplyResult` |
| POST | `/@trivia/api/batch` | `{ ops: Op[], label?: string }` | `ApplyResult` (last op's locator) |
| POST | `/@trivia/api/undo` | `{}` | `HistoryResult` |
| POST | `/@trivia/api/redo` | `{}` | `HistoryResult` |
| GET | `/@trivia/api/history` | — | `HistoryState` |
| GET | `/@trivia/api/manifest` | — | `{ manifest: TriviaManifest \| null, drift: Drift \| null }` |
| GET | `/@trivia/api/selection` | — | `SelectionState` |
| POST | `/@trivia/api/selection` | `{ locator, name }` or `{ locator: null }` | `SelectionState` |
| POST | `/@trivia/api/sync` | `{ input?, zod?, force? }` | `SyncResult` |
| GET | `/@trivia/api/refine/pages` | — | `(ListPage \| FormPage)[]` (every Refine page under `src/`) |
| GET | `/@trivia/api/refine/page` | `?file=` | `(ListPage \| FormPage)[]` (that file's) |
| POST | `/@trivia/api/refine/columns/plan` | `{ file, component?, changes: ColumnChange[] }` | `{ ops: Op[], label }` |
| POST | `/@trivia/api/refine/fields/plan` | `{ file, component?, changes: FieldChange[] }` | `{ ops: Op[], label }` |
| GET | `/@trivia/api/screenshot/next` | — | `{ id: string \| null }` (long poll) |
| POST | `/@trivia/api/screenshot` | `{ id, png, width, height }` or `{ id, error }` | `null` |

- `apply` and `batch` each create **one** history entry (a batch is a transaction: if any op
  fails, files already changed by earlier ops in the batch are restored and the error returned).
  Unchanged results (`changed: false`) create no entry. A new entry clears the redo stack.
- History entries store `{ file, before, after }` per changed file. Undo writes `before` only if
  the file still equals `after` (else 409 `conflict`, history untouched); redo is symmetric. All
  writes go through the engine's atomic, parse-validated write. History lives in the dev-server
  process (lost on restart) and is capped at 100 entries.
- `ApplyResult = { file, changed, locator: string | null, history: HistoryState }`.
- `HistoryResult = { files: string[], history: HistoryState }`.
- `HistoryState = { canUndo, canRedo, undoLabel: string | null, redoLabel: string | null }`.
- `manifest` is the project's `trivia.manifest.json` (`docs/data-provider.md`), null when it has
  none. `Drift = { status: "current" | "changed" | "unknown", source, manifestHash, specHash }`
  compares the manifest's `schemaHash` with contract-sync's canonical hash of the spec at
  `source.location`, so formatting alone is not drift. It is `unknown` for a URL source (not
  fetched on every request) or a spec file that is gone.
- `OutlineNode = { locator, name, line, isDirect, text?, children: OutlineNode[] }`: every JSX
  tree of the file, component by component in source order (`text` as in `NodeDetails`).
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
- `refine/*` is the Refine adapter (`docs/product.md`, `packages/vite-plugin-ast-locator/src/refine`).
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
  { action: "move", column, index }`. Changes apply in order, so a later one may name a column
  an earlier one added. The plan is value ops (`insertElement`, `removeElement`,
  `moveElement`) for the caller to apply as one entry (`/batch`). An added column follows
  Refine's shadcn examples:
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
  - a react-hook-form `<Controller name=…>` per field (shadcn v4's `Field` inside, since v4 has
    no `form` component).

  `FormPage = { file, component, action, resource, contract, schemaPath, defaultsPath, fields,
  available, container }`:
  - `action` is `refineCoreProps.action`, else the file name (`create.tsx`, `edit.tsx`);
  - `contract` is the request body it sends (`create` for a create form, `update` for an edit);
  - each field has its `label` (the `<FieldLabel>` text), `widget` (`Input`, `Select`…),
    `rule` (its zod rule as written), `hasDefault`, its Controller's locator, and the body
    `field`;
  - `available` lists the body's writable fields the form lacks.

  `FieldChange = { action: "add", field, index?, label? } | { action: "remove", field } |
  { action: "move", field, index }`. The changes in one plan are tracked: each Controller insert,
  removal or move renumbers its later siblings' locators. An added field is:
  - `setProperty` on the schema with its rule: `z.enum([…])`, `z.number()` (`.int()` for
    integers), `z.boolean()`, `z.iso.date()`, `z.email()`, `z.string().min(1, "Required.")`, …,
    plus `.nullable()` and `.optional()` from the contract;
  - `setProperty` on `defaultValues`: the spec's default, else `""`, the first enum value, `0` or
    `false` for a required field, and `undefined` for an optional one;
  - an `insert` of its Controller, after the last one or before the `index`-th. The widget is a
    `Select` for an enum, a number input, a date input, a `Checkbox` for a boolean, else a text
    input whose empty value is absent when the field is optional.

  A removal drops all three (and imports only it used). A move moves the Controller.
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
- `createFile` writes a new `.tsx`/`.jsx` file inside the root, making its directories. It
  is refused when the file exists (409 `conflict`; it never overwrites; with `"ifMissing": true`
  an existing file is kept as it is and the op is a no-op) and when `content`
  doesn't parse (422 `invalid_result`). In a history entry the file's `before` is `null`, so
  undo deletes it (only if it still holds what was written) and redo writes it again. The
  binding's `restoreFiles` takes `expected: null` (must not exist) and `content: null` (delete).
- **Value ops** (`insertElement`, `removeElement`, `moveElement`, `setProperty`,
  `removeProperty`) edit object and array literals rather than JSX. They address them by
  **value path** `<file>#<scope>#<head><step>*` (`crate::values`):
  - `scope` is a top-level function named as locators name it, or `module`;
  - `head` is a binding at the top of that scope's body (`columns`) or its first call to a
    function (`useForm()`);
  - steps are `.prop`, `[key=value]` (the element that is an object whose `key` is that string)
    and `[i]`.

  On the way, values unwrap to the literal they hold: parentheses and TS `as`/`satisfies`/`!`,
  a function to what it returns, a call to its first argument. So `columns` reaches the array in
  `useMemo(() => [...], [])`. `value` is source text for one expression; its imports work as a
  snippet's do. Layout follows the literal (one item per line with or without a trailing
  comma, or one line), and inserting then removing an item, or moving it there and back,
  restores the bytes. Keyed paths are their own stale guard: a missing key is 404
  `node_not_found`, and a key two elements share is 422 `unsupported`. `removeElement` and
  `removeProperty` drop imports only the removed code used. `locator` in the result is `null`.
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
