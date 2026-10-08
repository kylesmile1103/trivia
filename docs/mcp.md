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
  1.30.1, pinned).
- The same caller guard as the engine API (`docs/api.md`, Envelope): loopback clients only
  (unless `allowRemote`), a Host that names this machine, no foreign Origin. A refused caller
  gets 403 before any MCP message is read. The designer's proxy applies the same checks to
  `/@trivia/mcp` (`packages/designer/server/api-guard.ts`).

## Tools

| Tool | Input | Structured result |
| --- | --- | --- |
| `trivia_get_selection` (read-only) | — | `{ selection: NodeDetails & { component } \| null }` |
| `trivia_inspect` (read-only) | `{ locator }` | `{ node: NodeDetails & { component } }` |
| `trivia_outline` (read-only) | `{ file }` | `{ trees: OutlineNode[] }` (and an indented text tree) |
| `trivia_list_components` (read-only) | — | `{ components: [{ name, importSource, acceptsChildren, props }] }` |
| `trivia_screenshot` (read-only) | — | an image block: the canvas as a PNG (no structured result) |
| `trivia_sync_openapi` | `{ input?, zod?, force? }` | `SyncResult` |
| `trivia_apply` | `{ ops: Op[] (1+), label }` | `ApplyResult & { selection: SelectionState }` |
| `trivia_undo` | `{ label }` | `HistoryResult` |

- `component` is the selected element's `ComponentSchema` when it comes from the user's
  library (its props with enum options and defaults), else null. With nothing selected,
  `selection` is null and the text says to ask the user to select an element. A selection the
  source no longer matches (another tag at its locator) is a `stale_locator` error.
- `trivia_apply` takes every op of `docs/api.md`: `updateProp`, `setText`, `insert`,
  `insertChild`, `remove`, `move`, `moveNode`, `bindQuery`. **Every stale-locator guard is
  required** (`expectedName`, plus `expectedTargetName` / `expectedParentName`), so an agent
  working from a stale read is refused instead of editing the wrong element. One call is one
  undo entry, labelled `Agent: <label>`. With several ops, each op's locators must hold after
  the ops before it.
- `trivia_undo` undoes the newest entry of the shared history only if its label is the one
  given (the agent passes `history.undoLabel` from its last result). The user's own edits are
  never undone by mistake.
- `trivia_screenshot` returns what the user sees on the Trivia canvas, so the agent can check
  its edit: one `image` block (`image/png`, the canvas width, at most 4000 px of its height)
  and a text line with its size. The plugin has no browser; it asks the open designer
  (`GET /@trivia/api/screenshot/next`, `docs/api.md`), which renders the canvas document with
  `html-to-image` (`packages/designer/src/features/canvas/controller.ts`, `capture`). With no
  designer open it fails after 15 s (`screenshotTimeoutMs`), and the error says to ask the user
  to open it. Like any DOM-to-SVG capture it is close but not pixel-exact: `::placeholder`
  styles are not copied, so a placeholder shows in the text colour.
- `trivia_sync_openapi` regenerates the typed API client (TanStack Query hooks, zod schemas)
  and `trivia.manifest.json` from the OpenAPI spec, by default the one the manifest names, so
  an agent can pick up a backend change before building data UI. It overwrites generated files
  wholesale, so **it is refused when they have uncommitted changes** (commit first, or pass
  `force: true`); the result's `git` says what the guard found. It is not in the undo history.
- Refusals come back as tool errors (`isError`): `<code>: <message>` and, for the codes an
  agent can act on, what to do next (`stale_locator`: read the selection again and retry).

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

Tests: `packages/vite-plugin-ast-locator/test/{mcp,selection}.test.ts` (through the SDK client),
`packages/designer/src/shared/engine/selection-sync.test.ts`, and `e2e/mcp.spec.ts` (the whole
loop in a browser, and a screenshot taken by the real designer).
