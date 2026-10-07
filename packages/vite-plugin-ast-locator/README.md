# @trivia/vite-plugin-ast-locator

Dev-only Vite plugin that connects the user's app to the Trivia engine. It does two jobs:

1. **Locators.** During `vite serve`, every JSX opening element in every `.tsx`/`.jsx` module of the
   project gets `data-ast-node="<file>#<component>#<i.j.k>"` as its first attribute, with a source
   map. The engine computes the locators (`annotate`), so stamping and resolving share one algorithm.
   The component library is annotated too; its definition-site locators are overridden by
   usage-site ones wherever the component spreads `{...props}`.
2. **Engine API.** It serves `docs/api.md` at `/@trivia/api/*` from the same dev server.

```ts
// vite.config.ts — astLocator must come first, before react()
import astLocator from '@trivia/vite-plugin-ast-locator'

export default defineConfig({ plugins: [astLocator(), react(), tailwindcss()] })
```

Build the native engine (`pnpm build:engine`) and this package (`pnpm build:plugin`) first;
`pnpm dev:playground` does both. Without the engine, `vite` stops at startup and says so.

## Options

| Option | Default |
| --- | --- |
| `uiDir` | `components.json` `aliases.ui` mapped through `resolve.alias` (`@/components/ui` → `src/components/ui`); without a matching alias, `@/x` → `src/x`; else `src/components/ui` |
| `importBase` | `components.json` `aliases.ui`, else `@/components/ui` |
| `api` | `true`; `false` serves no API (locators only) |

## Behaviour worth knowing

- Skipped modules: `node_modules`, virtual ids, files outside the root, and ids with a query other
  than the `t`/`v` cache busters (`?raw`, `?url`, …). A module that fails to parse is left alone so
  Vite's own transform reports the syntax error.
- `apply` and `batch` run as one transaction in the binding (`applyOps`): ops are applied to the
  text in memory, then every changed file is written, all or nothing. A failing op writes nothing.
  Vite's watcher picks up the writes and sends a normal HMR update.
- Mutating requests run one at a time. Undo/redo restore byte-exact snapshots and answer
  `409 conflict` without writing anything when a file changed outside the designer. With nothing to
  undo or redo they answer `{ files: [] }`.
- Malformed requests (wrong method or content type, bad JSON, unknown endpoint) answer
  `400 invalid_op`; a foreign `Origin` answers `403 forbidden`.

```sh
pnpm --filter @trivia/vite-plugin-ast-locator test       # vitest (needs pnpm build:engine)
pnpm --filter @trivia/vite-plugin-ast-locator typecheck
```
