# What Trivia does

## Why Trivia

Visual editing of real code is no longer rare. What blocks adoption by working developers is trust:
tools that re-print a whole file after every click produce diffs nobody wants to review. Trivia is built
around the opposite rule.

- **Byte-preserving edits.** The engine parses with [OXC](https://oxc.rs), uses the AST only to find
  spans, and applies insert, replace and delete ranges to the original text. It never re-prints. A
  probe of OXC's code generator showed it adds semicolons, converts indentation to tabs and drops the
  parentheses in `return ( ... )`, so it is not used for writes.
- **Your source stays the source of truth.** Edit in the designer, in your IDE, or through an agent.
  All three act on the same files, and Vite HMR or Next.js Fast Refresh keeps the canvas in sync.
- **Guarded, reviewable operations.** Every change is one serializable `Op` with a stale-locator guard.
  Each is atomic, lands in an undo history as one entry, and is refused (never guessed) when the
  source no longer matches what the caller expected.
- **Contract-aware.** For Refine apps, Trivia connects the OpenAPI contract to the pages: columns,
  form fields, drift after a spec change, and new resource pages are planned from the contract and
  written as ordinary code.
- **No runtime added to your app.** Trivia is dev-only. The generated data layer depends on
  `@tanstack/react-query` and nothing proprietary.

## Key capabilities

| Area | What you get |
| --- | --- |
| **Visual canvas** | Your running app in a same-origin iframe with a hit-testing overlay, hover and selection boxes, drag to move, drop zones, zoom to fit, and a right-click menu for structure edits. |
| **Inspector** | Prop editors built from your own `src/components/ui/*` (variants from `cva(...)`, defaults, enum options), a Tailwind class manager and a style panel with two-phase editing (live CSS preview during a gesture, Tailwind classes written on commit). |
| **Palette and Layers** | Insert any component from your library; a Layers tree of the rendered app, rearranged by dragging rows (before, after, inside) or with Alt+↑/↓; move elements across files with imports carried along. |
| **Pages** | The app's routes, read from its source (React Router, TanStack Router, or Next.js App Router), with Refine labels and page files. Click a route to load it in the canvas or type a path. |
| **Engine ops** | `insert`, `insertChild`, `updateProp`, `setText`, `remove`, `move`, `moveNode`, `bindQuery`, `createFile`, plus value ops (`insertElement`, `removeElement`, `moveElement`, `setProperty`, `removeProperty`) for object and array literals. |
| **Undo / redo** | Guarded before/after snapshots. Byte-exact; refuses with `409 conflict` if a file changed elsewhere. |
| **Data tab** | Bound tables and create forms from an OpenAPI contract (TanStack Query, react-hook-form, zod, shadcn `Field`). |
| **Refine tools** | Columns, form fields, contract drift and new-resource pages, each as a single undo entry. |
| **MCP endpoint** | "Point and ask": select an element, tell your agent what to change, and it edits through the same guarded ops. |
| **Desktop shell** | An optional Tauri window on the designer, also as a macOS app (`.dmg` on each GitHub release). |

## The Refine + OpenAPI workflow

For apps built with Refine, shadcn/ui and an OpenAPI backend, Trivia treats the API contract as the
source of truth and plans page edits from it. The weekly jobs, in order:

1. **Columns.** Add, remove or reorder a list column from the contract. The cell renders by field type
   (badge for enums, formatted dates, Yes/No for booleans) and gets the matching filter.
2. **Form fields.** Add a contract field to a create/edit form: the zod rule with the contract's bounds,
   the default value and the field control in the form's own style (a `Controller` with shadcn's `Field`,
   or Refine's `<FormField>`) with a widget chosen by type, as one undo entry. It goes where the contract
   puts it, inside the developer's own grid or card.
3. **Contract drift.** After a spec change, list what each page references that the contract removed,
   retyped or newly requires, each with a one-click fix.
4. **New resource.** Generate the list, create, edit and show pages for a contract resource, register
   them in `<Refine resources>` and add the routes. Or drop `<OpenApiListInferencer />` (from
   `@trivia/openapi-inferencer`, a contract-driven replacement for Refine's inferencer) into a route.
   The page runs live, even with no records, and **Eject to disk** writes it and switches the route
   over.

Behind it, `@trivia/contract-sync` turns the spec into typed code and a deterministic
`trivia.manifest.json`:

```sh
pnpm --filter @trivia/contract-sync build
trivia-contract-sync --input openapi/customers.openapi.json --zod
trivia-contract-sync --input https://api.example.com/openapi.json --output src/api/generated
trivia-contract-sync --supabase-url https://<ref>.supabase.co --supabase-key "$TRIVIA_SUPABASE_KEY"
```

Generation is staged and verified; if anything mismatches, nothing in your project changes. Exit codes:
`0` ok, `1` failure, `2` usage error. Design and the `bindQuery` contract:
[`docs/data-provider.md`](data-provider.md). Product rationale: [`docs/product.md`](product.md).

## Design guarantees

These are enforced by tests, not just intended.

| Guarantee | How it is enforced |
| --- | --- |
| Bytes outside the edited ranges are unchanged | Exhaustive round-trip suite (also run on CRLF copies); fixtures pin real-world formatting cases. |
| A write never leaves a file that fails to parse | The result is re-parsed; the engine refuses to write if there are diagnostics. |
| A write is all or nothing | Multi-file batches run in memory and are written together; a failing op writes nothing. Writes are temp file plus rename. |
| A stale locator never edits the wrong node | Every op carries the expected element name; mismatches answer `409 stale_locator`. |
| Moves keep identifier scope | A move out of a `.map` callback or between components is refused unless every identifier still resolves to the same symbol. |
| One locator algorithm | The plugin and the engine share the Rust implementation. |
| Hostile or huge input is bounded | Files whose locators would exceed 2^22 segments are refused (`422 unsupported`); the napi crash suite bounds peak memory at 512 MiB per case. |
| Layering rules hold | `packages/designer/src/architecture.test.ts` enforces `app -> features -> shared` and no feature-to-feature imports. |

Offsets are UTF-8 bytes in Rust and UTF-16 in JavaScript. The binding converts at the boundary, and no
offset crosses it without a stated unit.
