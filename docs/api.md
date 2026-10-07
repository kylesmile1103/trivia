# Engine API (contract)

The designer talks to the engine over HTTP. `vite-plugin-ast-locator` serves these endpoints
from the **user's** Vite dev server under `/@trivia/api/`, calling the Rust engine through the
napi binding (`@trivia/engine`). The designer reaches them through its same-origin proxy.

TypeScript mirror of every shape: `packages/trivia-designer/src/bridge/types.ts`.
Rust source of truth: `crates/trivia_oxc_engine/src/{mutator,inspect,prop_analyzer,error}.rs`.

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
- **Host** (HTTP/2: `:authority`) names this machine: `localhost`, an IP literal, or an entry of
  Vite's resolved `server.allowedHosts` (`.example.com` also matches subdomains; `true` matches
  anything). This stops DNS rebinding, whose same-origin GETs carry no `Origin`. The plugin
  checks it itself, because Vite skips its own host check under `server.https`.
- **Origin**, when present, is `http(s)://` `localhost` / `127.0.0.1` / `[::1]` (any port). The
  opaque origin `null` is refused.

The designer's proxy passes all three: it connects from loopback, rewrites `Host` to the target
(`changeOrigin`), and its page's `Origin` is localhost. The proxy also hides its own client's
address, so the plugin cannot protect a designer that listens beyond loopback (`--host`); such a
proxy has to refuse non-loopback clients itself.

## Endpoints

| Method | Path | Body / query | `data` |
| --- | --- | --- | --- |
| GET | `/@trivia/api/health` | — | `{ root, uiDir, importBase, version }` |
| GET | `/@trivia/api/components` | — | `ComponentSchema[]` |
| GET | `/@trivia/api/inspect` | `?locator=` | `NodeDetails` |
| POST | `/@trivia/api/apply` | `{ op: Op, label?: string }` | `ApplyResult` |
| POST | `/@trivia/api/batch` | `{ ops: Op[], label?: string }` | `ApplyResult` (last op's locator) |
| POST | `/@trivia/api/undo` | `{}` | `HistoryResult` |
| POST | `/@trivia/api/redo` | `{}` | `HistoryResult` |
| GET | `/@trivia/api/history` | — | `HistoryState` |

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

## Ops (`Op`, tagged by `op`)

```jsonc
{ "op": "insert", "target": "<loc>", "placement": "before|after|firstChild|lastChild",
  "snippet": "<Button variant=\"destructive\">Delete</Button>",
  "imports": [{ "name": "Button", "source": "@/components/ui/button" }] }
{ "op": "insertChild", "parent": "<loc>", "index": 2, "snippet": "…", "imports": [] }
{ "op": "updateProp", "target": "<loc>", "expectedName": "Button", "prop": "variant", "value": "outline" }
{ "op": "remove", "target": "<loc>", "expectedName": "Button" }
{ "op": "move", "source": "<loc>", "expectedName": "Button", "target": "<loc>", "placement": "before" }
{ "op": "moveNode", "source": "<loc>", "expectedName": "Button", "parent": "<loc>", "index": 0 }
{ "op": "bindQuery", "target": "<loc>", "expectedName": "DataTable",
  "optionsFn": "listCustomersOptions", "optionsImport": "@/api/generated/@tanstack/react-query.gen",
  "optionsArgs": "{ query: { page: 1, pageSize: 20 } }", "resource": "Customer",
  "itemsPath": "items", "dataProp": "data", "loadingProp": "isLoading" }
```

- `value: null` removes the prop. Strings become `"…"` attributes; booleans, numbers, arrays
  and objects become `{…}` expressions. `true` on a bare shorthand attribute is a no-op.
  An existing attribute keeps its form: a `'…'` string keeps its quote (a character JSX can't
  hold raw is written as a reference, e.g. `&quot;`), `{'…'}` / `` {`…`} `` keep their literal
  kind, other `{…}` values keep their braces. Setting the value a prop already has is a no-op
  (`changed: false`). `null` removes every occurrence of a duplicated prop.
- `NodeDetails` reports runtime values: `attributes[].value` and `text` have HTML character
  references decoded (`"a &amp; b"` → `a & b`) and `text` follows JSX whitespace rules;
  `attributes[].source` is the text as written.
- `expectedName` (optional, recommended) makes a stale locator fail loudly (409) instead of
  editing the wrong node.
- `index` counts the parent's JSX children (same numbering as locator segments) **before** the
  op. `index == children.length` appends.
- Snippets must be exactly one JSX element/fragment. Every component it uses must already be
  bound in the file or listed in `imports`, else 422 `unresolved_component`.
  Nothing may surround the element (a comment or wrapping parentheses would become JSX text):
  400 `invalid_snippet`. `imports` the snippet doesn't reference are ignored; a name bound only
  as a type (`import type`) is refused with 422 `unsupported`.
- Cross-file `move` is not supported yet (422).
- `bindQuery` writes `const { data: customerData, isLoading: isCustomerLoading } = useQuery({ ...listCustomersOptions(…) })`
  as the first statement of the element's component, imports `useQuery` and the factory, and sets
  `data={customerData?.items ?? []}` / `isLoading={isCustomerLoading}`. It is idempotent (re-binding returns
  `changed: false`). Rules and refusals: `crates/trivia_oxc_engine/src/data_binder.rs`; design: `docs/data-provider.md`. Moving a node into itself or its own subtree
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
