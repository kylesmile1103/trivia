# LLD-05: React code generation (Vite target)

- Spec: `specs/005-react-codegen-vite` · Requirements: FR-RC-01 to FR-RC-12 ·
  ADR-0003, ADR-0004, ADR-0007, ADR-0009, ADR-0016
- Code: `packages/blueprint-compiler` (`@trivia/blueprint-compiler`); one engine op in
  `crates/trivia_oxc_engine/src/ops/replace_file.rs`; shared pieces of
  `packages/dev-service/src/refine/scaffold.ts`.

## 1. Pipeline

```
blueprint (valid) + manifests + contract manifest + project facts
  └─ lower ─► PageIR ─► print (target) ─► EmittedModule { file, code, requires }
                                             ├─ preview: served as a module
                                             └─ eject: Plan { ops, files, lock }
```

The compiler is a set of pure functions. It reads no files and calls no network. The adapter
(LLD-04) or the CLI gathers its inputs:

```ts
interface ProjectFacts {
  target: 'vite-refine' | 'next-refine'
  aliases: Record<string, string>          // components.json
  pagesDir: string                         // where list pages live, else "src/pages"
  style: { semicolons: boolean; quotes: 'single' | 'double' }   // from the entry file
  formStyle: 'Field' | 'FormField'         // as the Refine adapter decides it
  installed: Set<string>                   // registry items present in the project
}
function compilePage(bp: Blueprint, page: string, ctx: CompileContext): EmittedModule
function planEject(bp: Blueprint, pages: string[], ctx: CompileContext, lock: Lock): EjectPlan
```

⚑ Project facts take the majority quote and semicolon style of static imports in the entry
source. With no evidence or a tie, they use double quotes and semicolons.

## 2. Contract pages (FR-RC-02)

For `list`, `create`, `edit` and `show`, `compilePage` calls the Refine adapter's generator
with `{ resource, kind, fields, hideFields, title }`. The generator moves behind a small
interface in the dev service, taking the contract and the project facts and returning the page's
code, so the compiler does not import either host or service. The adapter passes it in.

⚑ LLD-13 moved the Refine adapter and the blueprint HTTP and MCP surfaces to
`packages/dev-service`. The generator takes one `ScaffoldRequest` and the service passes
it to the compiler. Both the existing Vite and Next hosts use the same Refine adapter.
Spec 012 owns the Next blueprint target.

⚑ Explicit fields keep the blueprint's order, with exclusions taking precedence. Omitting
fields keeps the existing generator's default selection.

`filters`, `rowActions` and `headerActions` are new generator inputs:

- `filters` chooses which fields get a filter. The filter component still comes from the
  field's type, as the columns tool decides it.
- An action is a button whose handler is compiled from its steps (section 4). Row actions go
  in the actions column, header actions in the page header.

⚑ A row handler receives the data record, and confirmation uses the browser's confirm dialog.
The generator puts header actions just below the Refine header, whose implementation may
ignore children. An explicit filter list controls filter widgets while preserving sorters.
Refine's notification hook supports success, error and progress. Blueprint error uses error,
and the other blueprint variants use success.

⚑ The compiler and the Refine adapter share the resource key derived from the collection
path, so hooks and registered Refine routes name the same resource.

A test runs `refine/pages/plan` and `compilePage` for the same resource with default options
and asserts equal bytes.

## 3. Custom pages: the IR (FR-RC-03)

```ts
interface PageIR {
  name: string                   // component and file name
  file: string
  route: string
  client: boolean                // any client-tier expression, event or exposed value
  imports: ImportIR[]            // derived from references (FR-RC-04)
  state: StateIR[]               // { name, setter, type, initial }
  queries: QueryIR[]             // { name, hook, args, fields: Record<bpField, tsPath> }
  mutations: MutationIR[]
  handlers: HandlerIR[]          // { name, params, body: StepIR[] }
  jsx: JsxIR                     // element | text | expr | cond | repeat
}
```

Lowering:

1. **Names.** A state entry `selectedId` becomes `[selectedId, setSelectedId]`. An exposed
   value of node `search` becomes `[searchValue, setSearchValue]`. A query `customers` becomes
   `customersQuery`. Handlers are `handle<Node><Event>`. A clash gets a numeric suffix, in
   document order, so the result is stable.
2. **Scope and rename.** The names above give the scope of LLD-03 and its rename map:
   `state.x` to `x`, `ui.n.value` to `nValue`, `params.id` to the router's param, and each
   blueprint query field to its path on the hook's return value.

   | Blueprint | Meaning |
   | --- | --- |
   | `data.<q>.items`, `.total` | Rows and total of a `list` query |
   | `data.<q>.record` | The record of a `one` query |
   | `data.<q>.result` | The response of a `custom` query |
   | `data.<q>.isLoading`, `.error` | Status of any query |

   The mapping to Refine's return shape lives in one file, `targets/refine-hooks.ts`, written
   against the pinned `@refinedev/core` types and covered by a `tsc` test. Do not write it
   from memory: Refine 5 changed these shapes.
3. **Queries.** `list` becomes `useList`, `one` becomes `useOne`, `custom` becomes
   `useCustom`. Parameters are emitted expressions. `enabled` maps to the hook's query options.
   A `DataTable` node does not use a page query: the composite owns its `useTable` (LLD-06).
4. **Exposed values.** A node with an exposed value gets `valueProp={state}` and
   `changeProp={(…) => setState(arg)}` by the manifest's `via`. When an action is bound to the
   same event, the handler sets the state first, then runs the steps.
5. **Actions.** Steps compile in order inside one `async` handler:
   - `setState`: the setter call;
   - `navigate`: Refine's `useGo`;
   - `mutate`: `useCreate`, `useUpdate`, `useDelete` or `useCustomMutation`, awaited;
   - `refetch`: the query's refetch;
   - `toast`: Refine's `useNotification`;
   - `call`: an import from `src/handlers/<page>.ts`, called with `{ event, state, setters }`.
     The file is created with a typed stub when missing, and never overwritten.
6. **JSX.** Nodes in `order`, per slot. `when` becomes `{cond && <X/>}`. `each` becomes
   `{list.map((item, index) => <X key={…}/>)}`. Slot wrappers come from the manifest's
   `parts`. Static props print as attributes by the rules `updateProp` uses (strings as
   `"…"`, the rest in braces). `className` prints verbatim (ADR-0016).

## 4. The printer (FR-RC-01, FR-RC-11)

`printModule(ir, facts): string`. Fixed section order: imports (packages, then aliases, then
relative, each sorted), the component function with hooks in the order state, queries,
mutations, navigation and notification, handlers, then `return (…)`. Two-space indentation.
A line longer than 100 columns breaks attributes one per line. Semicolons and quotes follow
`facts.style`. No timestamps, no generator banner in the file.

After printing, the module is parsed with the engine (`parse_error` here is a compiler bug and
surfaces as `internal`). Golden files pin the bytes. A `tsc` run over the fixture app with
every golden page checks types (FR-RC-05).

⚑ Static JSX text and attributes escape entity syntax while preserving the rendered value.
The compiler uses a relative import for a custom page's route registration.

⚑ The fixture app uses the banking mock API, contract and Refine UI from
`examples/refine-admin`, and the installed Card from `examples/playground`. Its TypeScript
aliases resolve the real components and generated contract types without duplicating them.

## 5. Preview (FR-RC-06)

The adapter keeps a map from preview id to page name and serves
`/@trivia/preview/<id>.tsx` by calling `compilePage` on each load, reusing the mechanism of the
inferencer previews, including the Tailwind stylesheet for classes no file has used yet.
A preview route, `/__blueprint/<Name>`, is registered in dev by a small client entry that the
plugin injects, so the canvas can navigate to it without touching the app's router file. The
store's change events invalidate previews, and the page reloads.

## 6. Eject (FR-RC-07 to FR-RC-10)

`planEject` returns, per page:

- `createFile` at `<pagesDir>/<resource-or-name>/<kind-or-name>.tsx` with the compiled bytes,
  or `replaceFile` when the lock says the file is unchanged since the last eject;
- the resource entry and the `<Route>`s, through the registration helpers the new-resource
  tool uses (`setProperty` or `insertElement` on `<Refine resources>`, `insert` of `<Route>`
  before the catch-all), each with its guards;
- `createFile` for `src/handlers/<page>.ts` when a `call` step needs it and it is missing;
- for the app document's `nav` and theme tokens: value ops on the layout's menu, and a guarded
  edit of the stylesheet's variables. These are skipped with a warning when the expected
  anchors are not found, never guessed.

Refusals: 422 with `requires` when a component is not installed; 409 when a page's file
differs from its lock hash; 409 when a route or file already exists and is not in the lock.

### The lock

```json
{
  "lockVersion": 1,
  "compiler": "0.3.0",
  "pages": {
    "CustomerOverview": { "file": "src/pages/customers/overview.tsx",
                          "hash": "sha256:…", "blueprintRev": "sha256:…" }
  }
}
```

No timestamps (NFR-02). The lock is written after the batch succeeds, in the same history
entry (LLD-04).

### `replaceFile`

```jsonc
{ "op": "replaceFile", "file": "src/pages/customers/overview.tsx",
  "expectedHash": "sha256:…", "content": "…" }
```

A new module under `ops/`, an `Op` variant, an example in `docs/api.md` and its pin in
`tests/errors.rs`, as `docs/architecture.md` asks. It reads the file, compares the SHA-256 of
its bytes (409 `conflict` on mismatch, 404 when missing), parses `content` (400 `parse_error`
on diagnostics), and writes atomically. It is the one op that replaces untouched code, and the
hash guard is what makes that safe.

⚑ The 404 code is `file_not_found`. After a hash match, the engine also parses the original
source so a batch rollback or undo can restore it through the ordinary guarded write path.

## 7. CLI and templates (FR-RC-12)

`trivia-blueprint`, the package's bin:

| Command | Does |
| --- | --- |
| `new <dir> [--target vite-refine]` | Copies the template, writes an empty blueprint, prints the `shadcn add` command for the kit |
| `validate [--json]` | Loads, validates, prints diagnostics. Exit 1 on errors |
| `compile <Page> [--out file]` | Prints or writes one compiled page |
| `eject [pages…] [--dry-run]` | Plans and applies through `@trivia/engine` directly, with the same guards |

`templates/vite-refine/` is a minimal app of `examples/refine-admin`'s shape: Vite, React,
Refine core with the React Router binding, Tailwind v4, `components.json`, the Trivia plugin,
a layout from refine-ui, an empty `<Refine resources>` with a catch-all route. It contains no
component source: those arrive through the shadcn CLI, which needs the network and is
therefore a printed command, not something `new` runs silently.

## 8. Tests

- Golden pages for a fixture blueprint covering every IR feature, checked byte for byte, then
  parsed by the engine and type-checked by `tsc` in the fixture app.
- The equality test of section 2.
- Eject on a copy of `examples/refine-admin`: plan, apply, undo restores every byte, redo.
- Lock rules: eject twice (the second is `replaceFile`), then edit the file by one byte (409).
- `replaceFile`: engine unit tests, round trips, CRLF, each refusal.
- Determinism: compile the fixture 20 times in shuffled document order, one hash.
- `e2e/blueprint.spec.ts`: preview in the canvas, eject, and select and edit an ejected
  element with the inspector.

## 9. Open points

- Whether `nav` and theme edits belong to eject or to the `new` template only. They are
  best-effort for now, and that is their weakest point.
- A page-level error boundary and loading skeleton, which the generator's pages have and
  custom pages do not yet.
