# refine-admin

A bank back office built the way Refine's `vite-shadcn` preset builds apps: Vite, React, Refine
(core, react-router, react-table, react-hook-form) and shadcn/ui, with refine-ui's components
installed from Refine's registry (`npx shadcn add https://ui.refine.dev/r/…`). It is the user
app for Trivia's Refine work (`docs/product.md`) and its e2e target (`e2e/refine/`).

```sh
pnpm build:engine && pnpm build:plugin              # at the workspace root, once
pnpm --filter refine-admin dev                      # the app, http://localhost:5173
TRIVIA_TARGET=http://localhost:5173 pnpm --filter @trivia/designer dev   # the designer
pnpm --filter refine-admin sync                     # regenerate src/api/generated + trivia.manifest.json
```

- **API:** `openapi/bank.openapi.json` (customers, accounts, transactions), served in memory by
  `mock-api.ts` with a fixed seed. `src/providers/data-provider.ts` is the app's own Refine data
  provider for it, as a real app has one.
- **Types:** pages type their rows with the generated `types.gen.ts` (`ColumnDef<CustomerDto>`),
  which is how Trivia matches a page to its contract resource when it names no resource.
- **Registry fixes** (refine-ui as published on 2026-10-09):
  - `layout/layout.tsx` imported shadcn's `Sidebar` primitive instead of refine-ui's own;
  - `data-table-filter.tsx` lacked labels for the `eqs`/`nes` operators that
    `@refinedev/core` 5.0.12 types require;
  - `error-component.tsx` had an unused `React` import.

  Day-2 apps carry fixes like these too.
- shadcn v4's registry has no `form` component (`field` replaced it), so forms here will use
  `Field` with react-hook-form's `Controller`.
