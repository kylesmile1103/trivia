# Implementation Plan: Designer Blueprint panel

**Branch**: `007-designer-blueprint-panel` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Design**: [LLD-07](../../docs/blueprint/lld/LLD-07-designer-blueprint-panel.md)

## Summary

A new designer feature, `features/blueprint`, mounted as a fifth left tab. It talks only to the
blueprint HTTP routes, dispatches eject plans through the action bus, and reaches the canvas
through `shared/canvas.ts`. Two pieces of existing code move to `shared/` so it can reuse them.

## Technical Context

- **Language**: TypeScript, React 19, the designer's shadcn components in `shared/ui`.
- **Dependencies**: none new.
- **Testing**: Vitest with jsdom beside the components; `e2e/blueprint.spec.ts`.
- **Constraints**: `app` imports `features`, which import `shared`. A feature never imports a
  feature. Every write goes through the patch API or `dispatch`.

## Constitution Check

| Principle | Status |
| --- | --- |
| IV Plans, not writes | Eject dispatches the plan's Ops. Documents change only through patches |
| V Guards | Revisions sent with every patch. A conflict reloads and reports |
| Layout | New code in one feature folder. Shared pieces moved first, in their own commits |

No violations.

## Project Structure

```
packages/designer/src/
  features/blueprint/      index.ts, api.ts, store.ts, PagesList.tsx, PageForm.tsx, NodeTree.tsx,
                           NodeProps.tsx, ExpressionInput.tsx, EjectDialog.tsx, Diagnostics.tsx,
                           ModelEditor.tsx, BackendDialog.tsx (Phase 2), *.test.tsx
  shared/engine/           blueprint client functions and mirrored types
  shared/lib/tree-drop.ts  the drop rules, moved from features/layers
  shared/components/       prop editor widgets, moved from features/inspector (if under a day)
  app/LeftPanel.tsx        the fifth tab, icons with tooltips
e2e/blueprint.spec.ts
```

## Approach

1. Mirror the types and add the client functions.
2. Move the drop rules to `shared/lib` (Layers keeps passing).
3. Tab, pages list, empty states.
4. Page form for contract kinds.
5. Preview and the eject dialog.
6. Conflict handling.
7. Node tree and props for custom pages.
8. Phase 2: model editor, backend dialog.

## Risks

- **Tab space.** ⚑ Icons with tooltips. Checked on a 1280 px wide window.
- **Sharing inspector widgets.** Time-boxed to a day. Otherwise plain inputs first.
