# LLD-02: Component manifests

- Spec: `specs/002-component-manifests` · Requirements: FR-MF-01 to FR-MF-07 · ADR-0009
- Code: `packages/blueprint/src/manifest/` (types, resolution, JSON Schema). The kit's own
  manifest files are in `packages/blueprint-compiler/kit/` (LLD-06).

## 1. Why a manifest

The engine's prop analyzer reads the user's `src/components/ui/*.tsx` and returns
`ComponentSchema[]` (`GET /@trivia/api/components`): name, import source, whether it accepts
children, and props with options and defaults from `cva`. That is enough for an inspector. A
compiler also needs what static analysis cannot see: which props are events, which value a
component exposes to expressions, which slots it has, and whether it needs the client.

## 2. Shape

```ts
interface ComponentManifest {
  type: string                         // "Select"
  source: {
    registry: 'shadcn' | 'refine' | 'local'
    item: string                       // registry item name, e.g. "select"
    import: { name: string; from: string }   // from is resolved per project
    parts?: Record<string, string>     // slot wrappers: { trigger: "SelectTrigger", ... }
  }
  props: PropSchema[]                  // the engine's shape: name, kind, options, default
  slots: Array<{ name: string; kind: 'nodes' | 'text'; accepts?: string[]; wrapper?: string }>
  events: Array<{ name: string; prop: string; payload?: string }>
  exposes: Array<{
    name: string                       // ui.<node>.<name>
    type: string                       // TypeScript type
    initial: unknown
    via: { valueProp: string; changeProp: string; changeArg: 'value' | 'event.target.value' | 'event.target.checked' }
  }>
  client: boolean                      // has events, exposes, or uses hooks internally
  template: { props?: Record<string, unknown>; children?: string }   // defaults for a new node
  composite?: 'DataTable' | 'Form'     // expanded by the compiler (LLD-06)
}
```

⚑ Style variants are an optional `variants` object keyed by the style in `components.json`.
A variant replaces whole fields of the base manifest and cannot change the type. Events use
the `on<Event>` names supported by the page document. Initial and template values are JSON,
and props may carry an optional description.

`componentManifestSchema` parses manifest files. `manifestJsonSchema()` generates the
equivalent draft 2020-12 schema for the files, including style variants.

Example, trimmed:

```json
{
  "type": "Input",
  "source": { "registry": "shadcn", "item": "input", "import": { "name": "Input", "from": "ui" } },
  "slots": [],
  "events": [{ "name": "onChange", "prop": "onChange", "payload": "React.ChangeEvent<HTMLInputElement>" }],
  "exposes": [{ "name": "value", "type": "string", "initial": "",
                "via": { "valueProp": "value", "changeProp": "onChange", "changeArg": "event.target.value" } }],
  "client": true,
  "template": { "props": { "placeholder": "" } }
}
```

`from: "ui"` means the project's `components.json` alias for `ui` plus the item's file. The
resolver never hardcodes `@/components/ui` (`CLAUDE.md` rule 9).

## 3. Resolution (FR-MF-02 to FR-MF-06)

`resolveManifests(input): { manifests, diagnostics }`, a pure function of:

- `kit`: the kit's manifest files;
- `overrides`: `blueprint/manifests/*.manifest.json`;
- `components`: the analyzer's `ComponentSchema[]` for this project;
- `aliases`: from `components.json`.

For each type:

1. Start from the override if there is one, else the kit manifest, else nothing.
2. Find the analyzer's schema by import name.
   - Found: `props` is the analyzer's list. The manifest may only annotate props that exist
     (mark one as an event, add a description). The user's file wins on options and defaults.
     ⚑ Descriptions of recognized props are in `propDescriptions`, keeping the analyzer list
     verbatim. Override prop, event and exposed value references absent from that list give
     an `override_prop_missing` warning at the declaration. Events and exposed values remain
     available because the analyzer can omit inherited props. Unknown props named in the
     override's `props` array do not enter the resolved list.
   - Not found, and the manifest is from the kit: the component is not installed. It stays in
     the result flagged `installed: false` with its registry item, so validation can report
     `missing_component` with a hint such as `pnpm dlx shadcn@latest add select`.
     ⚑ A missing entry keeps its declared props for discovery until the analyzer finds it.
     Refine item names expand to the [Refine registry URL](https://refine.dev/core/docs/ui-integrations/shadcn/components/data-table/).
     A missing local override points to the declared export to restore.
3. A schema with no manifest gets a derived one: registry `local`, a `children` slot when the
   analyzer says it accepts children, events for props named `on[A-Z]…` from the curated
   intrinsic list, no `exposes`, `client: true` when it has events.
4. Lowercase types are HTML elements. `intrinsics.ts` lists the supported tags (`div`, `span`,
   `p`, `h1` to `h4`, `section`, `header`, `footer`, `main`, `ul`, `li`, `a`, `img`, `form`,
   `label`) with a curated prop list each. ⚑ Non-void tags accept node children and a string
   `children` prop. The void tag `img` has neither. Intrinsics have no module import and
   default to `client: false`. A compiler determines whether a particular node uses events.

Nothing is installed during resolution (FR-MF-03).

## 4. What validation checks against a manifest

- `nodes[id].type` resolves, else `unknown_component`. Deferred kit types get the hint of
  FR-KT-07.
- `slot` is one of the parent's slots, and the child type is in `accepts` when given.
  ⚑ An absent slot is `unknown_slot`. A node in a text slot or a node excluded by
  `accepts` is `invalid_slot_content`. Both point at the child's `slot`.
- Each key of `props[id]` and `bindings[id]` is a prop, `children` when the type has a text
  slot, or an exposed value's `valueProp`. Static values match the prop's kind and options.
  ⚑ Text children are strings. An analyzer prop of kind `unknown` accepts any JSON value,
  since its source type is not expanded by the analyzer.
- Action keys name an entry of `events`. Unlisted actions get `unknown_event`.
- Binding the `changeProp` of an exposed value directly is refused: the compiler owns that
  wiring. Reacting to a change is an action on the event.
  ⚑ The `controlled_change_binding` error points at the binding and suggests the matching
  action by its public event name.
- ⚑ Kit events and exposed values can describe props that the analyzer skips, such as
  `onClick` from React's button props and `value` and `onChange` from its input props.
  The resolved prop list stays equal to the analyzer's list. A static exposed value with
  no analyzer prop is checked for `string`, `number` and `boolean` types. Other TypeScript
  types are left to the compiler.

⚑ `exposedScope(page, manifests)` produces the client `ui` root described in LLD-03.
It includes a `types` map (`types[nodeName][valueName]`) for the TypeScript consumer.
Only installed types with exposed values contribute members.

## 5. JSON Schema for agents (FR-MF-07, should)

`manifestsToJsonSchema(manifests)` returns one schema per type for the node's props, plus an
index `{ type, slots, events, exposes, installed }`. `GET /blueprint/components` and
`trivia_blueprint_get { what: "components" }` return both (LLD-04).

## 6. Tests

- Against `examples/refine-admin`'s components: `Button` takes its variants from the user's
  `cva`, not from the kit file.
- A deleted `ui/select.tsx` gives `missing_component` with the registry hint.
- A local component (`refine-ui`'s data table) gets a derived manifest.
- An override replaces a kit manifest, and one that annotates a missing prop is a diagnostic.
- Kit manifests validate against the manifest JSON Schema. Every `via.valueProp` and
  `changeProp` exists in the current shadcn source of that item (a fixture, refreshed with the
  kit).

## 7. Open points

- shadcn's base (Radix, Base UI, React Aria) changes some prop names (for example
  `onValueChange`). The kit keeps one manifest per type with per-base variants keyed by
  `components.json` `style`. The first release covers Radix and Base UI.
