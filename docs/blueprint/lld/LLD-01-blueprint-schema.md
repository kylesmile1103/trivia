# LLD-01: Blueprint schema and store

- Spec: `specs/001-blueprint-schema` · Requirements: FR-BP-01 to FR-BP-10 · ADR-0005, ADR-0013
- Package: `packages/blueprint` (`@trivia/blueprint`), TypeScript, no runtime dependency
  beyond zod. The model document's content is LLD-08; manifests are LLD-02.

## 1. Files

```
blueprint/
  app.blueprint.json
  model.blueprint.json              (LLD-08)
  pages/<Name>.page.json            one per page, <Name> is the page's PascalCase name
  manifests/<Type>.manifest.json    optional overrides (LLD-02)
  blueprint.lock.json               written by the compiler (LLD-05), never by ops
```

The directory defaults to `<root>/blueprint`, where root is the web app's root.

What the store reads (as built, `src/store.ts`): the app and model documents and every file in
`pages/`. The lock and `manifests/` belong to their features and are not read here. A file in
`pages/` that is not `<Name>.page.json` loads as kind `unknown` with an `unknown_document`
warning; a page whose `name` is not its file's `<Name>` is `file_name_mismatch` (layer 2). A
missing directory reads as an empty blueprint (`exists: false`), not an error.

## 2. Documents

### App

```json
{
  "$schema": "https://trivia.dev/schemas/blueprint/app.v1.json",
  "blueprintVersion": 1,
  "name": "BackOffice",
  "targets": { "web": "vite-refine", "api": "dotnet-minimal" },
  "auth": { "mode": "none" },
  "theme": { "tokens": { "radius": "0.5rem", "primary": "oklch(0.21 0.006 285.9)" } },
  "nav": [{ "page": "CustomerList", "label": "Customers", "icon": "users" }]
}
```

`targets.web` is `vite-refine` or `next-refine`. `auth.mode` is `none` or `oidc`. Token names
are shadcn's CSS variable names without the leading dashes.

As built (`src/types/app.ts`): `name` is PascalCase (it names the project). `targets.web` is
required and `targets.api` (`dotnet-minimal`) optional. `auth` defaults to `{ "mode": "none" }`,
`theme` to `{ "tokens": {} }` and `nav` to `[]`, so a file omits them when they hold their
default. A nav entry is `page` (a page name), `label` and an optional lucide `icon`.

### Page

```json
{
  "$schema": "https://trivia.dev/schemas/blueprint/page.v1.json",
  "blueprintVersion": 1,
  "id": "pg_01JDK3M7Q2X8Y4Z6A1B3C5D7E9",
  "name": "CustomerOverview",
  "route": "/customers/overview",
  "kind": "custom",
  "resource": "Customer",
  "public": false,
  "root": "n_01JDK3M8...",
  "nodes": {
    "n_01JDK3M8...": { "type": "div", "name": "page", "parent": null, "slot": null, "order": "a0" },
    "n_01JDK3M9...": { "type": "Card", "name": "summary", "parent": "n_01JDK3M8...", "slot": "children", "order": "a0" },
    "n_01JDK3MA...": { "type": "Button", "name": "refresh", "parent": "n_01JDK3M9...", "slot": "children", "order": "a1" }
  },
  "props":    { "n_01JDK3MA...": { "variant": "outline", "children": "Refresh" } },
  "bindings": { "n_01JDK3M9...": { "title": "`${data.customers.total} customers`" } },
  "styles":   { "n_01JDK3M8...": { "className": "grid gap-4 p-6" } },
  "control":  { "n_01JDK3MA...": { "when": "data.customers.total > 0" } },
  "state":    { "selectedId": { "type": "string | null", "initial": null } },
  "queries":  { "customers": { "kind": "list", "resource": "Customer", "params": { "pageSize": "20" } } },
  "actions":  { "n_01JDK3MA....onClick": [{ "do": "refetch", "query": "customers" }] }
}
```

Rules:

- `nodes[id]`: `type` (a manifest type or a lowercase HTML tag), `name` (unique in the page, a
  camelCase identifier), `parent`, `slot` (a slot of the parent's manifest), `order` (a
  fractional index string, compared bytewise among siblings in the same slot).
- A prop is in `props` (a JSON value) or in `bindings` (an expression string), never both.
- `control[id]`: `when` (render condition), or `each` + `as` + `key` (repeat). Expressions.
- `state[name]`: `type` (a TypeScript type, checked by `tsc` after emission) and `initial` (JSON).
- `queries[name]`: `kind` is `list`, `one` or `custom`; `resource` names a contract resource;
  `params` values are expressions; optional `enabled` expression. `custom` adds `operation`.
- `actions["<nodeId>.<event>"]`: steps, run in order. `do` is one of `setState` (`name`,
  `value`), `navigate` (`to`), `mutate` (`resource`, `operation`, `input`, `id`), `refetch`
  (`query`), `toast` (`message`, `variant`), `call` (`handler`, a function exported from
  `src/handlers/<page>.ts`, the escape hatch). Expression-valued fields are marked in the schema.
- Kinds `list`, `create`, `edit`, `show`: `resource` is required, `nodes` is empty, and
  `options` holds `fields`, `hideFields`, `title`, `filters`, and `rowActions` /
  `headerActions` (each `{ name, label, confirm?, steps }`).
- `public: true` marks a page whose static tier may be cached by the Next.js target (LLD-12).

Ids are `<prefix>_<ULID>`: `pg_` pages, `n_` nodes. State and query entries are keyed by name,
since expressions refer to them by name.

The example above shows `"public": false` for illustration; the canonical file omits it, as it
omits every property equal to its default (section 3). Refinements as built
(`src/types/page.ts`, `src/types/common.ts`), every rule a regular expression so the JSON
Schemas enforce exactly what zod does:

- A ULID is Crockford base32 with the 48-bit time first, so its first character is `0`–`7`.
- ⚑ Node, state and query names share one namespace per page and are not JavaScript reserved
  words: emitted code turns them all into identifiers (`const [selectedId, setSelectedId]`).
- Node types are PascalCase (manifest) or lowercase (HTML); slots are camelCase.
- Prop names are identifiers or hyphenated attributes (`aria-label`), never `__proto__`.
- ⚑ Action keys are `<nodeId>.on<Event>`: events are the component's `on…` props.
- Routes are absolute, literal segments or `:param`s, no trailing slash except `/`.
- Contract pages (`list`, `create`, `edit`, `show`) have no maps and no `root`; `options`
  defaults to `{}`. Custom pages require `root` and may omit any empty map. A node's entry in
  `props`, `bindings`, `styles` or `control` is never `{}`: the ops drop an emptied entry.
- `control` is `{ when }` or `{ when?, each, as, key }`: a repeat needs all three.
- `queries[name].params` defaults to `{}`. ⚑ A contract action's `confirm` is the
  confirmation text. ⚑ `toast.variant` is `default`, `success`, `info`, `warning` or `error`.
- ⚑ `styles[id]` holds `className` only (ADR-0016).
- ⚑ The model document (`src/types/model.ts`) is checked as an envelope (`$schema`,
  `blueprintVersion`) until LLD-08's content lands; its other properties keep their order on
  save.

## 3. Canonical serialization (FR-BP-04)

`serialize(doc): string` gives UTF-8 JSON with two-space indentation, `\n` line ends and a
final newline. Fixed properties appear in schema order. Map entries (`nodes`, `props`, …) are
sorted by key, bytewise. Arrays keep their order. Numbers print as JavaScript does. Properties
equal to their schema default are omitted. `rev(doc)` is `sha256:` plus the hex digest of the
serialized bytes. It is computed, never stored.

As built (`src/serialize.ts`): the order and the defaults come from walking the zod schemas, so
the types stay their one source. Bytewise means UTF-8 bytes. ⚑ The keys of free JSON (static
prop values, `initial`) sort bytewise too, so equal values are equal bytes. Printing goes
through ordered entries, not `JSON.stringify` of an object, which would put integer-like keys
(`"2"`, `"10"`) first. ⚑ The store's rev of a file is the hash of its bytes on disk
(`revOfText`), which equals `rev(doc)` for a canonical file; a hand edit that only reorders keys
therefore counts as a change, which is the safe side.

## 4. BlueprintOps (FR-BP-07)

Tagged by `op`, applied by `apply(blueprint, ops): Result`. Every op names `doc` (the file's
path under the blueprint directory) and `baseRev` (the rev its author read). Node ops also
carry `expectedType`.

| Group | Ops |
| --- | --- |
| App | `setApp` (merge of name, targets, auth, theme tokens), `setNav` |
| Page | `createPage`, `deletePage`, `setPageMeta` (name, route, kind, resource, public, options) |
| Nodes | `addNode` (type, name, parent, slot, `before` or `after` a sibling, or `index`), `removeNode` (with its subtree), `moveNode`, `renameNode` |
| Values | `setProp`, `setBinding`, `setStyle`, `setControl` (a `null` value removes) |
| Logic | `setState`, `removeState`, `setQuery`, `removeQuery`, `setActions` |
| Model | LLD-08 |

`addNode` and `moveNode` take a position, and the store computes `order` with fractional
indexing between the neighbours, so callers never invent order keys. `renameNode` rewrites
`ui.<old>` references in the page's expressions through `trivia_expr` (LLD-03). `removeNode`
deletes the subtree's entries in every map.

A batch is applied to an in-memory copy. It commits only if every `baseRev` matches, every op
applies and the result passes schema and reference validation. Manifest and expression
diagnostics are returned but do not block a write: a draft may be incomplete. Result:

```ts
interface ApplyResult {
  changed: boolean
  revs: Record<string, string>          // doc path -> new rev
  created: Record<string, string>       // name -> generated id, for ops that create
  diagnostics: Diagnostic[]
}
```

Errors (the envelope codes of `docs/api.md`): 409 `conflict` (stale `baseRev`, type mismatch,
duplicate name), 404 `node_not_found`, 400 `invalid_op`, 422 `invalid_result`.

As built (`src/apply/`, one file per group plus `draft.ts` for the shared guards):

- ⚑ `baseRev: null` means the document must not exist yet (`createPage`, `setApp` on a new
  blueprint). Every op's `baseRev` is checked against the state *before* the batch, all before
  any op runs, so ops of one batch on one document all carry the rev their author read. A
  mismatch is 409 with `details: { doc, expected, actual, revs }`, `revs` covering every
  document the batch names.
- ⚑ For `addNode`, `expectedType` is the type of the parent it adds to: the node it addresses.
- ⚑ `createPage` of kind `custom` also creates the root, a `div` named `page` (`rootType`
  changes the type), so every later node has a parent. The page's file is
  `pages/<name>.page.json`; another `doc` is 400.
- ⚑ `setPageMeta` with a new `name` moves the document to the new file (two writes); the nav
  entries must change in the same batch, or the result has dangling entries and is 422. A
  custom page keeps its kind; contract pages change kind among themselves.
- ⚑ `setProp` with a value removes the same prop from `bindings`, and `setBinding` removes it
  from `props`: an op moves a prop between the maps instead of creating `duplicate_prop`. An
  empty `className` removes the style like `null`.
- ⚑ `renameNode` without injected expression tools (`ApplyOptions.expressions`, LLD-03) is
  refused with the pointers of the expressions that mention `ui.<name>`, rather than leaving
  them stale. The check is textual and errs towards refusing.
- ⚑ `created` keys are `<Page>` for a page and `<Page>/<node>` for a node (and `<Page>/page` for
  a root), so two pages in one batch cannot collide. `revs` maps a deleted document to `null`.
- ⚑ Only errors the batch *introduces* block it (compared by code, document and pointer), so a
  broken file elsewhere does not freeze the rest of the blueprint.
- A document from a newer version cannot be edited or deleted by any op.
- `store.apply` returns `{ ok: true, result, writes }` or `{ ok: false, error }`; a refusal has
  no writes.

## 5. Validation (FR-BP-05)

```ts
interface Diagnostic {
  code: string            // stable, snake_case
  severity: 'error' | 'warning'
  doc: string             // "pages/CustomerOverview.page.json"
  pointer: string         // RFC 6901, "/bindings/n_01J.../title"
  message: string
  hint?: { ops?: BlueprintOp[]; text?: string }
  span?: { start: number; end: number; unit: 'utf16' }   // inside an expression
}
```

Layers, each skipped for a document the previous one failed on:

1. **Schema** (zod): shapes, enums, id and name patterns. `schema_violation`.
2. **References:** parents exist, one root, no cycles in `parent`; slots exist; a prop is not
   both static and bound; action keys name a node; `nav` names pages; routes are unique.
   `dangling_reference`, `duplicate_name`, `duplicate_route`, `parent_cycle`.
3. **Manifests** (LLD-02): node types resolve, props and events exist, slot content is allowed.
   `unknown_component`, `missing_component`, `unknown_prop`, `invalid_prop_value`, `unknown_event`.
4. **Contract:** `resource` and query operations exist in `trivia.manifest.json`; option
   fields exist on the resource. `unknown_resource`, `unknown_field`, `unsupported_operation`.
5. **Expressions** (LLD-03): the `expr_*` codes.

`validate(blueprint, ctx)` is pure. `ctx` carries the resolved manifests, the contract manifest
and an `analyzeExpressions` function, so the package needs neither the engine nor the network.

⚑ As built (`src/validate/context.ts`), `ctx` holds one check function per layer instead of
that data: `{ manifests?, contract?, expressions? }`, each `(blueprint) => Diagnostic[]`.
Why: the manifest format (LLD-02) and the contract manifest's use are specs 002 and later, so
this package would otherwise fix their shapes before they are designed. Each spec ships its
check and plugs it in; the package keeps the order and the skipping. A check sees only the
documents no earlier layer found an error in, and one that throws becomes a single
`check_failed` diagnostic while the next layer still runs.

Layers 1 and 2 as built (`src/validate/schema.ts`, `references.ts`), every code with a fixture
under `fixtures/invalid/<code>/<case>/`:

| Code | Severity | Points at |
| --- | --- | --- |
| `invalid_json` | error | `""` of a file that does not parse |
| `unsupported_version` | error | `/blueprintVersion` of a newer document, or one with no migration path |
| `unknown_document` | warning | a file in `pages/` that is not a page document |
| `missing_document` | warning | `app.blueprint.json` when there are pages but no app document |
| `schema_violation` | error | the offending value: an unknown property itself, the closest branch of a union, a bad map key, `__proto__` (⚑ zod drops that key silently, so it is refused before parsing) |
| `dangling_reference` | error | a missing parent, root, map entry, action key, ⚑ the `name` of a `setState` step or the `query` of a `refetch` step, a nav entry's `page` |
| `duplicate_name` | error | the later of two equal names among nodes, state and queries |
| `duplicate_route` | error | the `route` of the later page, in path order |
| `parent_cycle` | error | the `parent` of each node on the cycle (not those hanging below it) |
| ⚑ `invalid_root` | error | a second parentless node, a root with a parent or a slot |
| ⚑ `missing_slot` | error | a child whose `slot` is null ("slots exist" in layer 2 means present; the slot's name is checked against the manifest in layer 3) |
| ⚑ `duplicate_prop` | error | the bound prop (`/bindings/<id>/<prop>`) |
| ⚑ `duplicate_order` | warning | the later of two siblings sharing an order key (they still order by id) |
| ⚑ `file_name_mismatch` | error | the `name` of a page whose file says otherwise |
| `check_failed` | error | `""`: an injected check threw |

Hints with ops (T024): `duplicate_prop` carries the `setProp` with `value: null` that removes
the static value (⚑ the binding is kept), and names the `setBinding` alternative in words; a
dangling nav entry carries the `setNav` without every entry that points nowhere, one shared fix.
Both carry the document's current rev, so they apply as sent. `missing_document` and
`duplicate_order` advise in words.

## 6. Migrations (FR-BP-06)

`migrations/<kind>/v<N>-to-v<N+1>.ts` exports `(doc: unknown) => unknown`. `load` runs them in
order up to the current version and marks the document dirty, so the next write saves it at
the new version. A document from a newer version is refused with `unsupported_version`.
Version 1 has no migrations. The loader and a fixture for the mechanism ship anyway.

⚑ As built (`src/migrate/index.ts`), the migrations are a table, `MIGRATIONS[kind][N]`, rather
than files found by name. Why: version 1 has none, and a table is explicit about gaps (a
missing step is `unsupported_version`, not a silently skipped file) and lets tests inject a
table. When migrations exist, each can still live in `src/migrate/<kind>/v<N>-to-v<N+1>.ts` and
be listed in the table. The runner deep-copies the document, sets `blueprintVersion` and the
`$schema` suffix after each step, and never throws. ⚑ A migrated document keeps the bytes and
rev it was read with and is saved at the current version by the next batch that touches it;
a batch that does not touch it leaves it alone.

## 7. Store

`BlueprintStore` is the only code that touches the files:

```ts
interface BlueprintStore {
  read(): Promise<Blueprint>                       // all documents, migrated, with revs
  apply(ops: BlueprintOp[]): Promise<ApplyResult & { writes: FileWrite[] }>
}
interface FileWrite { file: string; before: string | null; after: string | null }
```

`apply` serializes changed documents and returns the writes without performing them. The
caller (the dev service, LLD-04, or the CLI) writes them atomically (temp file and rename) and
records the before and after bytes as one history entry. Reading always goes to disk: a hand
edit shows up as a new rev on the next read.

As built: `createStore({ dir, ids?, expressions?, ctx?, migrations? })`. Loading is the pure
`loadBlueprint(files)` over the files' text, so everything above the disk is testable without
one. `Blueprint` is `{ exists, docs }`, each entry `{ path, kind, text, rev, value?, doc,
diagnostics, migratedFrom? }`: `doc` is null when the file failed to parse or failed its schema.
`apply` resolves to `{ ok: true, result, writes } | { ok: false, error }` (section 4). Ids
default to a real ULID source and are injected in tests (`sequenceSource`).

## 8. Projection (FR-BP-10, should)

`project(page): string` prints a page as pseudo-TSX for people and agents to read: nodes as
elements named by type with a `name` attribute, static props as attributes, bindings in braces,
`when` and `each` as wrapping expressions, then state, queries and actions as a comment block.
It is not parsed back (ADR-0005).

As built (`src/project.ts`, snapshots in `src/__snapshots__/project/`): a static `children`
string is the element's text and a bound one is `{expr}` content; children in a slot other than
`children` sit in a `<slot:name>` element; an event prints as `onClick={/* 2 steps */}` with
its steps in the comment; nodes not reachable from the root are listed as `unattached`. A
contract page prints as one `<ListPage>` (`CreatePage`, `EditPage`, `ShowPage`) with its
options as attributes and its actions in the comment.

## 9. Tests

- Round trips: every fixture loads and saves to identical bytes. Shuffled key order serializes
  to the canonical bytes.
- One test per op: the result, the diff (only the expected lines change), every refusal.
- Fractional index: 1 000 inserts at the same position keep the order and unique keys.
- One fixture per diagnostic code, asserting code and pointer.
- The JSON Schemas (generated from zod) validate every fixture with ajv in strict mode.
- A property test: random valid op sequences keep the blueprint valid at layers 1 and 2.

Fixture layout as built: `fixtures/valid/backoffice/` (an app, a list page with every option, a
custom page using every map, all canonical); `fixtures/invalid/<code>/<case>/` with an
`expected.json` of the diagnostics; `fixtures/ops/<case>/ops.json` (a batch, `"@current"` for
the rev the author read) with a hand-written `expected.diff` of the lines each write changes, or
the expected refusal; `fixtures/migrate/v0` and `v1` for the migration mechanism. SC-002 is
pinned by `src/store.test.ts`: every op that changes one existing node is at most six lines of
one file (a move to another parent is the six: parent, slot and order).

## 10. Open points

Resolved for version 1:

- ⚑ No cap on fractional index key length. Measured: 1 000 inserts right after the same key
  grow keys to 169 characters; 1 000 at either end stay at 3. That is far from any practical
  limit, so no rebalance op ships now; one can come later without a format change, since keys
  are opaque strings.
- ⚑ `state` types stay free TypeScript, because `tsc` checks the emitted code (LLD-05).

Still open:

- An op cannot refer to a node created earlier in the same batch, since its id is generated
  then. An agent adding a card and a button inside it needs two batches. A placeholder (`$name`)
  resolved through `created` would fix it; it belongs with the agent surface (LLD-04).
- A hand-edited file whose siblings share an order key gets a warning; nothing renumbers it.

## 11. JSON Schemas (FR-MF-07's base, SC-005)

`src/schemas.ts` generates the app and page JSON Schemas (draft 2020-12, the input side, so
defaulted properties are optional) from the zod schemas, each with its `$id`. ⚑ The build
writes them to `schemas/app.v1.json` and `schemas/page.v1.json` at the package root, which are
committed and exported (`@trivia/blueprint/schemas/*`), and a test fails when they drift from
zod. ajv in strict mode, with the `x-trivia-expression` keyword declared, validates every valid
fixture and rejects every `schema_violation` fixture.
