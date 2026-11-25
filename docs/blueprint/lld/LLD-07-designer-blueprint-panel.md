# LLD-07: Designer Blueprint panel

- Spec: `specs/007-designer-blueprint-panel` · Requirements: FR-DS-01 to FR-DS-09
- Code: `packages/designer/src/features/blueprint/`, client additions in
  `src/shared/engine/`, one tab in `src/app/LeftPanel.tsx`.

## 1. Place in the designer

A new feature folder with its public API in `index.ts`, mounted by `app/` as a fifth tab of
the left column, **Blueprint**. The rules of `docs/architecture.md` apply and
`architecture.test.ts` enforces them: the feature imports only from `shared/`, and reaches the
canvas through `shared/canvas.ts` (`canvas.navigate` for previews).

The left column holds four tabs at 272 px today. A fifth needs either icons with tooltips or
an overflow menu. ⚑ Icons with tooltips, decided here so the layout work is not a surprise.

```
features/blueprint/
  index.ts              BlueprintTab
  api.ts                calls through shared/engine (summary, doc, patch, preview, plan, backend)
  store.ts              feature state: summary, the open document, pending patch
  PagesList.tsx         pages with status and diagnostics (FR-DS-01)
  PageForm.tsx          name, route, kind, resource, options (FR-DS-02)
  NodeTree.tsx          a custom page's nodes: add, remove, reorder (FR-DS-03)
  NodeProps.tsx         props and bindings of the selected node (FR-DS-03)
  ExpressionInput.tsx   an input with inline diagnostics from the patch result
  EjectDialog.tsx       files, registry items, confirmation (FR-DS-04)
  ModelEditor.tsx       entities, fields, relations (FR-DS-05, Phase 2)
  BackendDialog.tsx     the file plan before writing (FR-DS-06, Phase 2)
  Diagnostics.tsx       the list, each entry jumping to its field
```

`shared/engine/` gains the typed client functions and the types of LLD-04, mirrored from the
dev service as the other engine types are. ⚑ The blueprint handlers live in
`packages/dev-service`, behind `DevHost` (LLD-13). The designer uses their HTTP
envelope, including structured refusal details for diagnostics and registry items.

## 2. Behaviour

**Pages list.** One row per page: name, route, kind, a status chip and error and warning
counts. `draft` offers Preview and Eject. `ejected` offers Open (navigate the canvas to the
real route) and Eject again. `edited` offers Open only, with a line saying the code has
changed since eject and is now the truth (ADR-0003). A button adds a page.

**Page form.** Kind decides the fields: contract kinds show the resource (from the contract
manifest), field checklists, title, filters and actions; `custom` shows the node tree. Each
change is one patch, labelled by what changed ("Blueprint: set route of CustomerList").
⚑ The reducer permits kind changes within contract kinds. A custom page keeps its kind.
A resource or kind change keeps the selected fields that are available in the new operation.
Template field and filter defaults have a separate checkbox. Structured action steps use
a JSON array editor with an explicit save, so every LLD-01 step can be represented.

**Node tree and props.** The tree is built from the flat maps and reuses the drop rules of the
Layers tab (before, after, inside), which move into `shared/lib/` since a second feature needs
them. Adding a node opens the list of manifests, with not-installed types marked. `NodeProps`
renders one editor per manifest prop. A toggle switches a prop between a static value and a
binding. Exposed values and events are listed with the names expressions should use
(`ui.search.value`).

It does not reuse the inspector's editors directly: features do not import features. The prop
editor widgets the two share move to `shared/components/` first. ⚑ If that refactor is larger
than a day, the panel ships with plain inputs and the move becomes its own task.

**Preview.** Calls `POST /blueprint/preview`, then `canvas.navigate(route)`. Preview elements
carry no locators, so the canvas shows a banner: "Preview of a draft page. Eject to edit it on
the canvas." With FR-DS-09 (could), the compiler stamps `data-bp-node` in preview modules only,
and a click selects the node in the tree. ⚑ The canvas derives the banner from the
actual `/__blueprint/` path, so it follows navigation and replaces the missing-locators notice
for these routes.

**Eject.** `POST /blueprint/plan`. A 422 with `requires` shows the `shadcn add` command to
copy. Otherwise the dialog lists the files and the route and resource changes. Confirm
dispatches the plan's ops through the action bus (`dispatch`, `shared/state/actions.ts`), so it
is one entry of the shared history, then calls `POST /blueprint/ejected`. The canvas navigates
to the real route, where every element is now selectable.

**Model editor (Phase 2).** A list of entities, and for the selected one a grid of fields
(name, type, required, constraints, default) with relations and API options below. Each cell
edit is a model op (LLD-08). Reserved names and dangling relations show inline.

**Generate backend (Phase 2).** `mode: "plan"` first: a table of files with create, update,
unchanged or refused, and an optional migration name. Confirm runs `mode: "write"`. Backend
writes are outside the undo history, and the dialog says so. The solution's git status is the
safety net.

**Undo and redo.** Patches are entries of the shared history, so the toolbar's undo works. The
panel re-reads the summary after every history change.

**Empty states.** No blueprint: one button creates `app.blueprint.json` with the detected
target. No contract: contract kinds are disabled, with a pointer to the Data tab's sync. ⚑ Initialization uses
`App` as the initial document name and selects the web target from the designer's
existing health response (`next-refine` for Next, `vite-refine` for Vite).

**Diagnostic focus.** ⚑ A finding focuses the closest field matching its JSON pointer,
opening its page first when needed. Document-level findings focus the editor region.

## 3. State and concurrency

The feature keeps the last summary and the revs of the documents it shows. Every patch sends
those revs. On 409 `conflict` (an agent or a hand edit got there first) it re-reads and
re-renders, and tells the user their change was not applied. It never retries a write on its
own.

It polls `GET /blueprint` on window focus and after each history change. The plugin has no
push channel, and one is not added for this.

## 4. Tests

- Vitest and jsdom per component: the page form by kind, the node tree's drop rules, the
  expression input showing a diagnostic at its span, the eject dialog's two outcomes.
- `architecture.test.ts` still passes, and gains nothing special for this feature.
- `e2e/blueprint.spec.ts` (with LLD-05): create a contract page, preview, eject, undo; build a
  small custom page, bind a text to an input, preview and type; a conflict from a concurrent
  MCP patch.
- Phase 2 adds: edit the model, plan the backend, see the file table.

## 5. Open points

- Whether draft custom pages deserve canvas editing (drag onto the preview). It would need
  locators for code that is in no file. Out for now: the tree is the editor until eject.
