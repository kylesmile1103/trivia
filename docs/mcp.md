# MCP endpoint (point and ask)

Agents (Claude Code, Cursor, or any MCP client) edit the user's code through Trivia the way
the designer does: guarded, byte-preserving ops that land in the designer's undo history.
The first workflow is **point and ask**: the user selects an element on the Trivia canvas and
tells the agent what to change ("make this an outline button", "put a New badge before
this"). The agent reads the selection and applies ops to it, and the designer shows each
edit at once.

`@trivia/vite-plugin-ast-locator` serves it on the **user's dev server** at `/@trivia/mcp`,
next to the engine API (`docs/api.md`). It needs no extra process or install, and it is
always the version of the engine it runs on.

## Connect

With the user's app running (`vite`, port 5173 here):

```sh
claude mcp add --transport http trivia http://localhost:5173/@trivia/mcp
```

Or commit it for the project, in `.mcp.json`:

```json
{ "mcpServers": { "trivia": { "type": "http", "url": "http://localhost:5173/@trivia/mcp" } } }
```

Turn it off with `astLocator({ mcp: false })`; `api: false` turns off both.

## Transport and security

- Streamable HTTP, **stateless**: every POST gets a fresh server, and responses are JSON (no
  SSE stream; GET answers 405). Built on the official SDK (`@modelcontextprotocol/sdk`
  1.32.2, pinned).
- The same caller guard as the engine API (`docs/api.md`, Envelope): loopback clients only
  (unless `allowRemote`), a Host that names this machine, no foreign Origin. A refused caller
  gets 403 before any MCP message is read. The designer's proxy applies the same checks to
  `/@trivia/mcp` (`packages/designer/server/api-guard.ts`).

## Tools

| Tool | Input | Structured result |
| --- | --- | --- |
| `trivia_get_selection` (read-only) | — | `{ selection: NodeDetails & { component } \| null, history: HistoryState, hint? }` |
| `trivia_inspect` (read-only) | `{ locator }` | `{ node: NodeDetails & { component } }` |
| `trivia_outline` (read-only) | `{ file }` | `{ trees: OutlineNode[] }` (and an indented text tree) |
| `trivia_list_components` (read-only) | — | `{ components: [{ name, importSource, acceptsChildren, props }] }` |
| `trivia_list_routes` (read-only) | — | `{ routes: AppRoute[] }` (and a line per route: URL, page component, file) |
| `trivia_get_page` (read-only) | `{ file? }` | `{ file, pages: ListPage[], hint? }` |
| `trivia_edit_columns` | `{ file, component?, changes: ColumnChange[] (1+), label }` | `ApplyResult & { page: ListPage, selection }` |
| `trivia_edit_fields` | `{ file, component?, changes: FieldChange[] (1+), label }` | `ApplyResult & { page: FormPage, selection }` |
| `trivia_contract_drift` (read-only) | — | `{ spec, pages: PageDrift[], note? }` |
| `trivia_add_pages` | `{ resource, pages?: PageKind[], label }` | `ApplyResult & { files, resources }` |
| `trivia_screenshot` (read-only) | — | an image block: the canvas as a PNG (no structured result) |
| `trivia_sync_openapi` | `{ input?, zod?, force? }` | `SyncResult & { note? }` |
| `trivia_apply` | `{ ops: Op[] (1+), label }` | `ApplyResult & { selection: SelectionState }` |
| `trivia_undo` | `{ label }` | `HistoryResult` |

- `component` is the selected element's `ComponentSchema` when it comes from the user's
  library (its props with enum options and defaults), else null. With nothing selected,
  `selection` is null and `hint` says to ask the user to select an element. A selection the
  source no longer matches (another tag at its locator) is a `stale_locator` error whose advice
  is to ask the user to select again (reading it again can't help). `history` is the shared
  undo history, so an agent in a fresh session can see what `trivia_undo` would undo.
- `trivia_apply` takes every op of `docs/api.md`: `updateProp`, `setText`, `insert`,
  `insertChild`, `remove`, `move`, `moveNode`, `bindQuery`. **Every stale-locator guard is
  required** (`expectedName`, plus `expectedTargetName` / `expectedParentName`), so an agent
  working from a stale read is refused instead of editing the wrong element. One call is one
  undo entry, labelled `Agent: <label>`. With several ops, each op's locators must hold after
  the ops before it.
- `trivia_undo` undoes the newest entry of the shared history only if its label is the one
  given (the agent passes `history.undoLabel` from its last result or from
  `trivia_get_selection`). The user's own edits are never undone by mistake.
- `trivia_get_page`, `trivia_edit_columns`, `trivia_edit_fields`, `trivia_contract_drift` and
  `trivia_add_pages` are the Refine adapter (`docs/product.md`,
  `docs/api.md` `refine/*`). `trivia_get_page` reads a file's list and form pages: the selected
  element's file when none is given, every page under `src/` with neither. Each page has its
  columns or fields as the source has them and the contract fields it doesn't have yet.
  `trivia_edit_columns` adds contract fields as typed columns and removes or reorders columns by
  key, in order, as one `Agent: …` undo entry, and returns the page as it now reads.
  `trivia_edit_fields` does the same for a form page's fields (rule, default and control
  together), against the create or update request body. The control is written in the form's
  style: a `Controller` with shadcn's `Field`, or Refine's `<FormField>`.
  `trivia_contract_drift` lists where pages no longer match the contract (`docs/api.md`
  `refine/drift`). Each issue's `fix.changes` go to `trivia_edit_columns` or
  `trivia_edit_fields`; a `note` says to sync first when the spec file changed.
  `trivia_add_pages` generates a contract resource's missing pages (`docs/api.md`
  `refine/pages/plan`); with neither file nor selection, `trivia_get_page` lists the resources
  and the pages each has and could have.
  Fixes name columns and fields by key (a `rebuild` finds the position when it is planned), so a
  list read before another fix ran still applies correctly.
  `trivia_apply` also takes the value ops (`insertElement`, `removeElement`, `moveElement`,
  `setProperty`, `removeProperty`) for edits the adapter doesn't plan, such as renaming a header.
  The chain ops (`setCallArgument`, `insertCall`, `removeCall`) edit one call of a zod rule in
  place, such as `.max(100)` → `.max(500)`, and leave the rest of the rule as written.
- `trivia_screenshot` returns what the user sees on the Trivia canvas, so the agent can check
  its edit: one `image` block (`image/png`, the canvas width, at most 4000 px of its height)
  and a text line with its size. The plugin has no browser; it asks the open designer
  (`GET /@trivia/api/screenshot/next`, `docs/api.md`), which renders the canvas document with
  `html-to-image` (`packages/designer/src/features/canvas/controller.ts`, `capture`). With no
  designer open it fails after 15 s (`screenshotTimeoutMs`), and the error says to ask the user
  to open it. Like any DOM-to-SVG capture it is close but not pixel-exact: `::placeholder`
  styles are not copied, so a placeholder shows in the text colour. It works while the designer
  is a background tab or a minimized window (`features/canvas/capture.ts` rasterizes without
  waiting for an animation frame, which a hidden page never gets). A page with a `<canvas>` or
  `<video>` still needs a frame to clone those, so there a hidden designer fails after 10 s
  with an error that asks the user to bring it to the front.
- `trivia_sync_openapi` regenerates the typed API client (TanStack Query hooks, zod schemas)
  and `trivia.manifest.json` from the OpenAPI spec, by default the one the manifest names, so
  an agent can pick up a backend change before building data UI. It overwrites generated files
  wholesale, so **it is refused when they have uncommitted changes** (commit first, or pass
  `force: true`); the result's `git` says what the guard found. It is not in the undo history.
  `contractChanged: false` (with a `note`) means the spec's schema is the one the manifest
  already had, so the agent can tell the user the spec hasn't been updated rather than report
  an API change.
- Refusals come back as tool errors (`isError`): `<code>: <message>` and, for the codes an
  agent can act on, what to do next (`stale_locator` from `trivia_apply`: read the selection
  again and retry). The advice is per tool where a code means something else: a `conflict`
  from `trivia_undo` (another entry is next) or `trivia_sync_openapi` (uncommitted generated
  code) is not a file that changed on disk.
- **Put what the agent needs in the structured result.** A tool's text block is a one-line
  summary plus the JSON, but Claude Code gives the model only `structuredContent` when a tool
  returns it. So hints (`hint`, `note`) are fields of the data, not just of the summary.

## The selection

- The designer posts its selection (`POST /@trivia/api/selection`) whenever the user selects
  something, once the inspector has named it. The plugin keeps the latest, in memory.
- An agent's edit moves the selection along with its element. Locators are positions, and
  each op adds, removes or moves exactly one element, so the new locator is index arithmetic
  (`packages/vite-plugin-ast-locator/src/api/selection.ts`, `rebase`). It is kept only if the
  tag there is still the selected one; otherwise the selection is dropped, never retargeted.
  After a batch of several ops the locator is only re-checked, not moved.
- The designer adopts an agent's change on its next history sync (every 2 s, and after every
  re-render).
- After every re-render the designer also re-checks the selected element's tag, so an edit
  from elsewhere (the user's IDE) that put another element at the selected locator drops the
  selection. Such a drop is not posted, so it cannot erase a better answer from the plugin.

## Tried with a real Claude Code session (2026-10-09)

`claude -p` (Claude Code 2.1.294, Opus 5.5) with only this server (`--strict-mcp-config`), the
playground's files readable, and the designer open in a headless browser with an element
selected by a click. Each prompt was a fresh session:

| Prompt | What the agent did |
| --- | --- |
| "Make this an outline button." | get_selection → `updateProp` variant (2 calls) |
| "Put a small 'New' badge right before this button." | list_components → `insert` before, with the import |
| "Rename this button to 'Save project', then check how the footer looks." | `setText`, then a screenshot it described correctly |
| "Undo the rename you just did." (fresh session) | **failed at first**: no read showed the history, so it couldn't name the entry. Now `history` comes with the selection, and it undoes exactly that entry |
| "Make this bigger." (nothing selected) | asked the user to select an element |
| "Move this after the save button." | inspect parent → `move` with both guards |
| "Make this red." after a hand edit put a `<Badge>` at the selected locator | refused as stale and asked the user to select again, in one call. It used to re-read the selection first, as the old advice said |
| "Below the settings card, add a table listing our customers from the API." | read the manifest, then one transaction: `createFile` (a table component), `insert`, `bindQuery`; checked it with a screenshot |
| "The backend team changed the customers API. Regenerate our API client." | sync; it used to report the regeneration as an update. Now `contractChanged: false` lets it say the spec hasn't changed |

### The Refine tools, with a real session (2026-10-09)

The same setup on `examples/refine-admin`, with the designer open on the customers list:

| Prompt | What the agent did |
| --- | --- |
| "In the customers table, also show the KYC status, right after Status." | get_page → `trivia_edit_columns` add `kycStatus` at index 3 (badge + multi-select filter), 2 calls |
| "Our create customer form should also ask for a phone number." | get_page → `trivia_edit_fields` add `phone` after Email |
| "Accounts need create, edit and detail pages." | `trivia_add_pages` (create, edit, show); then it read the new form and **relabelled the currency options**: the generator had written "Eur", "Usd", "Gbp". Fixed: codes keep their case |
| "The backend team just updated the bank API spec. Bring the app in line with it." | drift → `trivia_sync_openapi` → drift → removed the Email column, rebuilt Status (column and edit field), added `nationality` to the create form, and checked drift was empty. It then **repaired two side effects by hand**: "Gb / Us / Vn" labels (same fix), and a rebuilt Status column that **lost its sorting**, because generated enum columns weren't sortable. Fixed: every scalar column sorts |

The second fix shows a rebuild's cost: it replaces the column with the generated shape. A
narrower fix for `enum_changed`, updating only the options, would keep customisations.

Tests: `packages/vite-plugin-ast-locator/test/{mcp,selection}.test.ts` (through the SDK client),
`packages/designer/src/shared/engine/selection-sync.test.ts`, and `e2e/mcp.spec.ts` (the whole
loop in a browser, and a screenshot taken by the real designer).

## Blueprint authoring

The shared dev service supports blueprint reads and guarded patches on Vite and Next.js.
Blueprint tools are available on loopback connections, including when Vite allows remote
source editing.
Call `trivia_blueprint_get` with no arguments for the summary, with `what: "doc"` and a
summary path for a document, or with `what: "components"` for the component catalog. Set
`projection: true` on a page read to include its TSX projection.

```json
{"name":"trivia_blueprint_get","arguments":{"what":"summary"}}
```

Read the catalog before choosing node types or props. It includes JSON Schemas, availability,
slots, events and exposed values.

```json
{"name":"trivia_blueprint_get","arguments":{"what":"components"}}
```

After the customers page exists, read it for its current revision and node IDs.

```json
{"name":"trivia_blueprint_get","arguments":{"what":"doc","path":"pages/Customers.page.json","projection":true}}
```

Call `trivia_blueprint_patch` with one or more operations and a label. Use `baseRev: null`
when creating a document. Use the read's revision for an existing document and the current
type for a node or parent guard. A successful patch returns its `revs`, new IDs under
`created`, `diagnostics`, `entry` and `summary`.

```json
{"name":"trivia_blueprint_patch","arguments":{"label":"Add customers","ops":[{"op":"createPage","doc":"pages/Customers.page.json","baseRev":null,"name":"Customers","route":"/customers","kind":"list","resource":"Customer"}]}}
```

After each patch, inspect `summary.pages[].errors`, `diagnostics` and `summary.next`. A draft
can be saved with an invalid resource. The `unknown_resource` diagnostic names the resources
available in the contract, so you can correct it with `setPageMeta` and the new revision.
Fix each reported error and re-read the summary to verify the draft. If a patch returns
`conflict`, read the documents named by `error.details.revs` before retrying.

The patch schema includes the guarded model ops, such as `setModel` and `setEntity`. Read
`model.blueprint.json` before editing it. The summary gives its revision and entity names.

To undo a patch, pass its `entry` to `trivia_undo`. The label includes the `Agent: ` prefix.
`trivia_get_selection` also returns the next undo label in `history.undoLabel`.

`trivia_blueprint_preview` accepts a page name and optional `includeCode`. After the page
compiler lands in spec 005, use the returned route in the designer and call
`trivia_screenshot` when it loads. The tool currently returns `unsupported`.

```json
{"name":"trivia_blueprint_preview","arguments":{"page":"Customers"}}
```

`trivia_blueprint_eject` accepts a label and optional page names. The compiler will use
one shared undo entry for the source files and lock. The tool currently returns
`unsupported`.

```json
{"name":"trivia_blueprint_eject","arguments":{"pages":["Customers"],"label":"Eject customers"}}
```

`trivia_blueprint_backend` accepts a mode of `plan` or `write`, with optional `migration`
and `force`. It currently returns `unsupported` pending the trivia-dotnet bridge.

```json
{"name":"trivia_blueprint_backend","arguments":{"mode":"plan"}}
```

### Blueprint authoring with Claude Code (2026-11-25)

Claude Code 2.1.332 (Sonnet 5.5) connected to the standalone dev service on a fresh copy
of the Refine example. Strict MCP config exposed only Trivia, and the built-in tools were
disabled. The prompt asked for BackOffice with customer and account lists, using `Client`
for the customer resource on the first patch to exercise diagnostic recovery.

The first run omitted `targets.web` on `setApp` and retried with `vite-refine` after
`invalid_op`. The empty summary and the published op schema now call out
`targets.web` as required when creating the app. On a fresh copy, Claude Code used one
summary read and two patches with zero refused calls. The draft's
`unknown_resource` hint listed Account, Customer and Transaction. Claude Code used the
returned revision to change `Client` to `Customer`. An independent HTTP read verified
two draft pages with zero errors and zero warnings.
