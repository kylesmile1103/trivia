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
  `SyncResult = { source, outputDir, files, schemaHash, resources: string[], git }`, where `git`
  says what the guard found: `"clean"`, `"forced: replaced uncommitted changes in …"` or
  `"not a git work tree: nothing was guarded"`. A contract-sync failure is 422 `unsupported`.
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
