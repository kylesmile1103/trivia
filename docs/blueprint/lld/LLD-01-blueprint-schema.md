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

## 3. Canonical serialization (FR-BP-04)

`serialize(doc): string` gives UTF-8 JSON with two-space indentation, `\n` line ends and a
final newline. Fixed properties appear in schema order. Map entries (`nodes`, `props`, …) are
sorted by key, bytewise. Arrays keep their order. Numbers print as JavaScript does. Properties
equal to their schema default are omitted. `rev(doc)` is `sha256:` plus the hex digest of the
serialized bytes. It is computed, never stored.

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

## 6. Migrations (FR-BP-06)

`migrations/<kind>/v<N>-to-v<N+1>.ts` exports `(doc: unknown) => unknown`. `load` runs them in
order up to the current version and marks the document dirty, so the next write saves it at
the new version. A document from a newer version is refused with `unsupported_version`.
Version 1 has no migrations. The loader and a fixture for the mechanism ship anyway.

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

## 8. Projection (FR-BP-10, should)

`project(page): string` prints a page as pseudo-TSX for people and agents to read: nodes as
elements named by type with a `name` attribute, static props as attributes, bindings in braces,
`when` and `each` as wrapping expressions, then state, queries and actions as a comment block.
It is not parsed back (ADR-0005).

## 9. Tests

- Round trips: every fixture loads and saves to identical bytes. Shuffled key order serializes
  to the canonical bytes.
- One test per op: the result, the diff (only the expected lines change), every refusal.
- Fractional index: 1 000 inserts at the same position keep the order and unique keys.
- One fixture per diagnostic code, asserting code and pointer.
- The JSON Schemas (generated from zod) validate every fixture with ajv in strict mode.
- A property test: random valid op sequences keep the blueprint valid at layers 1 and 2.

## 10. Open points

- A cap on fractional index key length, with a rebalance op if it is ever reached.
- Whether `state` types should be a closed set instead of free TypeScript. Free for now,
  because `tsc` checks the emitted code.
