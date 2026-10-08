# @trivia/designer

The visual editor. It serves itself under `/__trivia/` and proxies every other path, HTTP and
WebSocket, to the user's Vite dev server, so the canvas iframe is same-origin with the app
(CLAUDE.md, rule 7). Every edit goes to the engine API (`/@trivia/api`, served by
`@trivia/vite-plugin-ast-locator`) as one `Op` (`docs/api.md`).

```sh
pnpm --filter playground dev                                     # the user app, :5173
TRIVIA_TARGET=http://localhost:5173 pnpm --filter @trivia/designer dev   # :4400/__trivia/
pnpm --filter @trivia/designer test        # vitest, including src/architecture.test.ts
pnpm --filter @trivia/designer typecheck
```

## Layout

Feature slices (see `docs/architecture.md`). Imports point down this list only:

```
server/              the designer's own dev-server code (Node): the engine API guard
src/
  app/               composition root: main.tsx, the shell (App.tsx), the left panel's tabs, the connect screen
  features/          vertical slices; each exposes its public API from index.ts
    canvas/          iframe, overlay, hit-testing, selection, drag-move, drop zones, previews
    data-explorer/   the project's API (trivia.manifest.json): bound tables and create forms (Data tab)
    inspector/       props, class manager, style panel (style/), CSS→Tailwind (tailwind/)
    layers/          the rendered app's element tree (Layers tab)
    palette/         the user's components as insertable templates
    toolbar/         history, zoom, mode, theme, connection status
  shared/            used by any feature, knowing none
    engine/          the engine API client, its types, and the session that syncs them
    state/           the zustand store and the action bus (every edit goes through it)
    commands/        global commands and keyboard shortcuts
    canvas.ts        the canvas API contract (installed by features/canvas): previews, fit zoom, layers
    template.ts      what the palette and Data tab insert, and the ops one insert runs (templateOps)
    insert.ts        click-to-insert into the selection, and the template drag payload
    components/      the designer's own shared components
    ui/              shadcn/ui (components.json points `npx shadcn add` here)
    lib/             small helpers (cn, env, keyboard)
```

`src/architecture.test.ts` fails when a feature imports another feature, when `shared/`
imports a feature, or when the app reaches past a feature's `index.ts`.

The palette and the inspector read the **user's** `src/components/ui`, never `shared/ui`.
