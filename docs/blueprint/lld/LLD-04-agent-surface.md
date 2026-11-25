# LLD-04: Agent surface (HTTP and MCP)

- Spec: `specs/004-blueprint-agent-surface` · Requirements: FR-AG-01 to FR-AG-07 · ADR-0013
- Code: `packages/dev-service/src/blueprint/` (the adapter), routes registered in
  `src/api/http.ts`, tools in `src/mcp/tools.ts`. Contracts go into `docs/api.md` and
  `docs/mcp.md` with the first endpoint.

## 1. The adapter

⚑ Spec 013 moved the HTTP API, MCP endpoint and Refine adapter into `packages/dev-service`.
The blueprint routes, store and tools live there too, so both Vite and Next.js serve them
through the same `DevHost` service.

```
src/blueprint/
  index.ts        route and tool registration
  store.ts        BlueprintStore over the files (LLD-01), reads through fs, writes through the service
  context.ts      builds the validation context: manifests (LLD-02), contract manifest, expressions (LLD-03)
  preview.ts      compiled modules at /@trivia/preview/<id>.tsx (LLD-05)
  plan.ts         eject plans (LLD-05)
  backend.ts      runs trivia-dotnet (LLD-09)
```

It sits beside `src/refine/` and follows its rule: **plans, not direct writes**. Anything that
changes source files returns Ops that the caller applies through `/batch`.

Blueprint documents are JSON, and the engine's `createFile` writes only `.tsx` and `.jsx`. So
`EngineService` gains one method:

```ts
writeDocuments(writes: FileWrite[], label: string): Promise<HistoryEntryRef>
```

It runs in the service's edit queue, checks each path is inside the blueprint directory, checks
each file still has its `before` bytes (else 409 `conflict`), writes with a temp file and a
rename, and records one history entry of before and after snapshots. Undo and redo restore
them through the guarded document writer. ⚑ The native `restoreFiles` preflights through
`Workspace::exists`, which only accepts `.tsx` and `.jsx`, and reparses replacement source
through `Workspace::restore`. JSON snapshots use a guarded writer in `blueprint/`; the shared
history dispatches document entries to it and source entries to the native engine.

## 2. HTTP (FR-AG-01)

All under `/@trivia/api/blueprint`, with the envelope and the caller guard of `docs/api.md`.

| Method | Path | Body or query | `data` |
| --- | --- | --- | --- |
| GET | `/blueprint` | none | `BlueprintSummary` |
| GET | `/blueprint/doc` | `?path=` and optional `&projection=1` | `{ path, rev, doc, projection? }` |
| GET | `/blueprint/components` | none | `{ components: ManifestIndex[], schemas }` |
| POST | `/blueprint/patch` | `{ ops: BlueprintOp[], label }` | `PatchResult` |
| POST | `/blueprint/preview` | `{ page }` | `PreviewResult` |
| POST | `/blueprint/plan` | `{ pages?: string[] }` (default: every draft page) | `EjectPlan` |
| POST | `/blueprint/ejected` | `{ pages: string[], entry }` | `{ lockRev }` |
| POST | `/blueprint/backend` | `{ mode: "plan" \| "write", migration?: string, force?: boolean }` | `BackendResult` |

```ts
interface BlueprintSummary {
  dir: string
  exists: boolean
  app: { rev: string; name: string; targets: object } | null
  model: { rev: string; entities: string[] } | null
  pages: Array<{ name: string; path: string; rev: string; route: string; kind: PageKind;
                 status: 'draft' | 'ejected' | 'edited'; file?: string; errors: number; warnings: number }>
  diagnostics: Diagnostic[]
  next?: string                       // one suggested step, as data
}
interface PatchResult extends ApplyResult { entry: string; summary: BlueprintSummary }
interface PreviewResult { page: string; route: string; module: string; code: string;
                          requires: RegistryItem[]; diagnostics: Diagnostic[] }
interface EjectPlan { ops: Op[]; files: string[]; requires: RegistryItem[]; warnings: string[];
                      lock: object; label: string }
interface BackendResult { files: Array<{ path: string; kind: 'generated' | 'scaffold';
                          action: 'create' | 'update' | 'unchanged' | 'refused' }>;
                          written: boolean; diagnostics: Diagnostic[]; log: string }
```

- `status`: `draft` when the lock has no entry; `ejected` when the file's hash matches the
  lock; `edited` when it differs or the file is gone.
- A blueprint that does not exist is not an error: `exists: false`, and `createPage` or
  `setApp` creates the directory on the first patch.
- `patch`: 409 `conflict` on a stale `baseRev` with the current revs in `error.details`, so the
  caller can re-read only what moved (FR-AG-05).
- `preview`: 422 `invalid_result` when the page has error diagnostics, with them attached.
- `plan`: 422 `unresolved_component` when `requires` is not empty (FR-RC-10); 409 `conflict`
  for a page whose status is `edited`.
- `ejected`: called after the plan's batch succeeded. It writes the lock through
  `writeDocuments`, amending the same history entry, so one undo takes back files and lock.

## 3. MCP (FR-AG-02)

| Tool | Input | Structured result |
| --- | --- | --- |
| `trivia_blueprint_get` (read-only) | `{ what?: "summary" \| "doc" \| "components", path?, projection? }` | The matching HTTP result |
| `trivia_blueprint_patch` | `{ ops (1+), label }` | `PatchResult` |
| `trivia_blueprint_preview` (read-only) | `{ page }` | `PreviewResult` without `code` unless `includeCode` |
| `trivia_blueprint_eject` | `{ pages?, label }` | `ApplyResult & { files, requires, summary }` |
| `trivia_blueprint_backend` | `{ mode, migration?, force? }` | `BackendResult` |

- `trivia_blueprint_eject` plans, applies through the same batch path as `trivia_apply`, then
  records the lock. One `Agent: <label>` undo entry, which `trivia_undo` takes back (FR-AG-07).
- `trivia_blueprint_preview` returns the route. The agent then calls `trivia_screenshot`
  after the designer's canvas loads it. When no designer is open, the result says so in `next`.
- Tool descriptions state the loop: get, patch until `errors` is 0, preview, eject. What
  `docs/mcp.md` learned holds: hints are data fields (Claude Code shows the model
  `structuredContent`), and error advice is per tool.
- The tool input schema for `ops` is generated from the zod definitions of LLD-01, so the two
  cannot disagree.

## 4. Errors

Codes come from `docs/api.md`. New in `error.details`:

| Situation | Status and code | Details |
| --- | --- | --- |
| Stale revision | 409 `conflict` | `{ revs }` |
| Node type mismatch | 409 `conflict` | `{ node, expectedType, actualType }` |
| Page invalid for preview or plan | 422 `invalid_result` | `{ diagnostics }` |
| Component not installed | 422 `unresolved_component` | `{ requires }` |
| Page edited since eject | 409 `conflict` | `{ page, file }` |
| `dotnet` or `trivia-dotnet` not found | 422 `unsupported` | `{ hint }` |
| Blueprint from a newer version | 422 `unsupported` | `{ found, supported }` |

## 5. Security

- Same guard as every `/@trivia/api/` route, and the designer's proxy applies it too.
- `path` parameters are resolved inside the blueprint directory. Anything else is 422
  `path_outside_root`.
- `backend.ts` starts `dotnet` with an argument array, a fixed executable name, the solution
  root as the working directory and a timeout. Its output is returned as `log`, truncated.

## 6. Tests

- Dev-service tests on a copy of `examples/refine-admin`: create a page by patch, read it back,
  undo, redo; a stale `baseRev`; two patches in a row from one read (the second is refused).
- The guard: a non-loopback caller gets 403 on every blueprint route, including through the
  designer proxy.
- MCP: the tools list matches a snapshot; `trivia_blueprint_patch` then `trivia_undo` restores
  the bytes.
- `e2e/blueprint-mcp.spec.ts`: patch, preview, screenshot, eject, undo, in a browser.
- A real-session check, as `docs/mcp.md` did: a Claude Code session with only this server
  builds a two-page blueprint. What it trips on is fixed before the phase closes.
