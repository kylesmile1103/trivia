# LLD-03: Expression compiler

- Spec: `specs/003-expression-compiler` · Requirements: FR-EX-01 to FR-EX-08 · ADR-0006
- Code: `crates/trivia_expr` (pure Rust, no I/O), exposed by `crates/trivia_napi`. OXC crates at
  the workspace's pinned version. Check API names in `references/oxc` first (`CLAUDE.md`).

## 1. The language

A binding is one TypeScript expression. Allowed:

| Category | Forms |
| --- | --- |
| Literals | string, number, boolean, `null`, `undefined`, template literals, array and object literals (with spread) |
| Access | member (`a.b`), computed member (`a[b]`), optional chaining |
| Operators | arithmetic, comparison, logical, `??`, unary `!`, `-`, `+`, `typeof`, conditional `? :` |
| Calls | methods and globals on the allowlist; arrow functions only as arguments to them |
| Types | `as` and `satisfies` are accepted and kept |

Refused with `expr_unsupported_syntax`: assignment and update, `new`, `await`, `yield`,
`this`, `super`, `delete`, the comma operator, function expressions and declarations, tagged
templates, `import()`, JSX, regular expression literals, class expressions.

- ⚑ The operator allowlist covers arithmetic, relational and equality symbols, and the listed
  logical and unary operators. Bitwise operators, `in`, `instanceof`, `void`, bigint literals,
  and postfix TypeScript `!` are outside the subset.
- ⚑ Callbacks are synchronous expression-bodied arrows supplied directly as call arguments.
  Parentheses around a callback are allowed. Object literals support data properties, computed
  keys, shorthand and spread. Methods and accessors are rejected.

Allowlist, as data in `allow.rs`:

- String: `trim`, `toLowerCase`, `toUpperCase`, `startsWith`, `endsWith`, `includes`,
  `slice`, `padStart`, `padEnd`, `split`, `replaceAll`.
- Array: `map`, `filter`, `find`, `some`, `every`, `includes`, `slice`, `join`, `flatMap`,
  `reduce`, `at`, `toSorted`, and the `length` property.
- Number: `toFixed`.
- Globals: `Math.*` (pure members), `Number`, `String`, `Boolean`, `Object.keys`,
  `Object.values`, `Object.entries`, `JSON.stringify`, `Intl.NumberFormat(...).format`,
  `Intl.DateTimeFormat(...).format`, `Date.now` (which makes the expression `client`).

A call to anything else is `expr_impure_call`. The check is by name: OXC has no type checker,
so a method on a value of unknown type is judged by its name alone.

- ⚑ The `Math` calls are listed individually, excluding `random`. Computed call targets need a
  literal key. The Intl factories are permitted as receivers of an immediate `.format` call.

## 2. Scope

The caller describes what an expression may reference:

```jsonc
{
  "roots": {
    "params": { "tier": "server", "members": ["id"] },
    "search": { "tier": "server", "members": null },          // null: any member
    "user":   { "tier": "server", "members": ["id", "name", "roles"] },
    "state":  { "tier": "client", "members": ["selectedId"] },
    "data":   { "tier": "query",  "members": ["customers"] }, // tier comes from the query
    "ui":     { "tier": "client", "members": { "search": ["value"] } }
  },
  "locals": ["item", "index"]                                 // from each/as, row, event, value
}
```

A free identifier that is neither a root, a local, an arrow parameter nor an allowed global is
`expr_unknown_root`. A member outside a root's list is `expr_unknown_member`. Arrow parameters
shadow roots, with a warning.

- ⚑ Known member shapes accept arrays of names, nested objects, and `null` for an open shape.
  The same representation can describe both `ui` and each query's result fields.
- ⚑ Page-wide and per-expression `locals` accept a name array (all `client`) or a name-to-tier
  object. Per-expression locals take precedence, so one batch can include nested repeat scopes.
- ⚑ `expr_shadowed_root` is a warning on the parameter name, including names in destructuring
  patterns. Value references resolve to arrow bindings first, then site and page locals, then
  roots and built-ins. Known-member checks diagnose the first missing property in a chain.
- ⚑ Direct built-in member reads are limited to the allowlist and the Math and Number constants.
  Type syntax is left to TypeScript and does not contribute value reads.

## 3. Analysis

`analyze(request) -> response`, batched:

```jsonc
// request
{ "scope": { }, "expressions": [{ "id": "/bindings/n_1/title", "source": "`${data.customers.total} customers`" }] }
// response
{ "unit": "utf16",
  "results": [{ "id": "/bindings/n_1/title", "ok": true,
                "deps": ["data.customers"], "tier": "client", "diagnostics": [] }] }
```

- **Dependencies** are the distinct `root.member` pairs referenced (`ui.search.value` counts
  as `ui.search`), in source order.
- ⚑ A bare root or a computed root member with no literal name records `root.*`. It carries
  the root's tier or, for a query root, the highest tier of any query there.
- **Tier.** `static` with no dependencies. Otherwise the highest tier among them, in the
  order `static < server < client`. A dependency on `data.<q>` takes the query's tier, which is
  the highest tier of that query's parameter expressions. An `event`, `item` under a client
  `each`, `row` or `value` local makes the expression `client`.
- ⚑ A query with no valid parameter expressions starts at `static`. Tier increases propagate
  across query references in any input order. A direct reference to the built-in `Date.now`
  is `client`, including when passed as a callback.
- **Cycles.** The caller passes every expression of a page with the entity it defines (a
  query's parameters define `data.<name>`, sent as the optional `defines` field). The crate builds the graph and reports each cycle
  once as `expr_cycle`, with the path in the message, on every expression taking part.
- ⚑ Overlapping cycles produce one diagnostic per participating expression. The message shows a
  deterministic closed walk covering the whole strongly connected group. Invalid expressions
  contribute no edges. Wildcard reads use one graph vertex for the whole root.

Diagnostics carry `start` and `end` as UTF-16 code units from the start of the expression
string, and the response says so (`CLAUDE.md` rule 2). Internally spans are UTF-8 bytes and are
converted at the boundary, as `annotate_utf16` does.

## 4. Emission (FR-EX-06)

```jsonc
// request
{ "expressions": [{ "id": "…", "source": "data.customers.total > 0 && state.selectedId !== null" }],
  "rename": { "data.customers.total": "customers.total", "state.selectedId": "selectedId" } }
// response
{ "results": [{ "id": "…", "ts": "customers.total > 0 && selectedId !== null" }] }
```

Rename keys are member paths of any depth. The longest key that prefixes a member chain is
replaced by a span splice, so the page compiler can map each field of a query result to
wherever the data hook keeps it (LLD-05).
Everything else, whitespace and comments included, is copied as written. The result is parsed
again, and a result with diagnostics is an `internal` error, never output. An object literal at
the top level is wrapped in parentheses only when the caller asks for an arrow body.

- ⚑ Emission enforces the syntax and call subset and uses the caller's name map without checking
  it against a page scope. It rewrites free value references, including literal bracket keys.
  A renamed shorthand expands to `key: value` so its original property key stays the same.
- ⚑ Identity prefixes keep their original bytes and suppress shorter replacements. The emitter
  reparses changed output, including any arrow-body parentheses, and uses the initial parse
  for an unchanged result. Arrow-body parentheses sit inside leading and trailing trivia.

`renameReferences` uses the same splice to rewrite `ui.<old>` to `ui.<new>` in stored sources,
for the `renameNode` op (LLD-01).

- ⚑ Reference renaming edits only the property name of a free `ui` access, preserving optional
  chaining, comments and string delimiters. It can rewrite parseable drafts even if their
  syntax is outside the binding subset. An ambiguous scope or parse error with a possible
  `ui` reference returns a diagnostic so the guarded op can refuse the rename atomically.
  `from` and `to` must have the blueprint node-name character shape.

- ⚑ Emit accepts a batch-wide `arrowBody` flag. `renameReferences` accepts `{ expressions, from, to }`
  with unqualified node names. Both responses label spans with `unit: "utf16"` and return either
  `ts` or `diagnostics` for each input, preserving the rest of the batch when one input fails.

## 5. napi surface

```ts
export declare function analyzeExpressions(requestJson: string): string
export declare function emitExpressions(requestJson: string): string
export declare function renameReferences(requestJson: string): string
```

Strings in, strings out, the JSON envelope of the other engine calls. A malformed request is
`invalid_op`. A panic is caught at the binding and returned as `internal`. The napi crash suite
gains cases for all three, with the existing RSS bound.

- The binding uses the existing engine thread and envelope. `napi build` regenerates the
  three declarations in `crates/trivia_napi/index.d.ts` with the other exports.

## 6. Limits

An expression is at most 4 096 bytes and 64 levels deep. A batch is at most 10 000
expressions. Past a limit the answer is `expr_too_large` for that expression, never a crash.

- ⚑ OXC 0.153.0's `Parser::parse_expression` consumes through EOF and already gives
  source-relative spans. This replaces the parenthesis wrapper and offset correction in the plan.
- ⚑ The depth walk counts expressions, statement and type nodes, patterns, and nested JSX.
  Inputs longer than 128 bytes parse on a scoped thread with a 32 MiB stack. OXC recurses
  before the depth walk can reject the input, and a 4 095-byte parenthesized expression
  exhausted the default Rust test stack.

## 7. Tests

- A table of accepted and refused forms, one line each, with the expected code and span.
- Dependency and tier tables, including a query whose parameters depend on another query.
- Cycles: direct, through a query, through three entities.
- Emission round trips: with an identity rename the output equals the input byte for byte,
  comments and odd spacing included. With CRLF inside a template literal too.
- Offsets: an expression with astral characters reports correct UTF-16 spans.
- A fuzz target that feeds arbitrary bytes to `analyze` and asserts no panic.
- A benchmark in CI: 1 000 typical expressions under 50 ms (NFR-04).

## 8. Open points

- Whether to allow `new Date(x)`. Refused for now. Date formatting goes through
  `Intl.DateTimeFormat` or a handler.
- Shape checks under `data.<q>` (is `total` a field of the list result?) need the contract's
  types. The first version checks the first level only (`items`, `total`, `record`,
  `isLoading`, `error`, as LLD-05 defines them), and `tsc` checks the rest after emission.
