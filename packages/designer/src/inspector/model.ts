// What the inspector shows for a node: engine details (what the source says) joined with the
// prop schema (what the component accepts). Pure, so the rules are testable without React.
//
// The source is the truth. A literal value (`variant="ghost"`, `disabled`, `{3}`) is editable;
// anything the engine can only show as source text (`{plan}`, `{cn(...)}`, `icon={<X />}`,
// `{...props}`) is read-only, because writing a literal over it would silently delete user logic.

import type { AttrDetails, ComponentSchema, JsonValue, NodeDetails, PropSchema } from '@/bridge/types'

export type Literal = string | number | boolean

/** The setter a prop gets. `className` is not here: it has its own class manager. */
export type Control =
  | { kind: 'enum'; options: string[] }
  | { kind: 'boolean' }
  | { kind: 'string' }
  | { kind: 'number' }

export type ValueState =
  | { state: 'absent' }
  | { state: 'literal'; value: Literal }
  | { state: 'readonly'; source: string; reason: ReadonlyReason }

export type ReadonlyReason = 'expression' | 'element' | 'mismatch'

export interface PropRow {
  name: string
  /** null for attributes the schema doesn't know (id, htmlFor, key, …). */
  schema: PropSchema | null
  /** null when the prop can only be displayed (unknown type and no literal to edit). */
  control: Control | null
  value: ValueState
  /** Literal default from the schema, shown while the attribute is absent. */
  defaultValue: JsonValue | undefined
}

export type ClassNameState =
  | { state: 'absent' }
  | { state: 'literal'; value: string }
  | { state: 'readonly'; source: string }

export interface InspectorModel {
  /** Schema props in schema order (className excluded). */
  props: PropRow[]
  /** Source attributes the schema doesn't list, in source order. */
  extra: PropRow[]
  /** `{...spread}` attributes, as source text. */
  spreads: string[]
  /** null when the element can't take a className (a component whose schema has none). */
  className: ClassNameState | null
  /** Names already written on the element (for "add prop" validation). */
  written: Set<string>
}

/** Lower-case tag without a dot: an intrinsic DOM element (`div`, `p`), not a component. */
export function isIntrinsic(name: string): boolean {
  return /^[a-z]/.test(name) && !name.includes('.')
}

/** The component scope of a locator (`file#Dashboard#0.1` → `Dashboard`). */
export function locatorScope(locator: string): string | null {
  const parts = locator.split('#')
  return parts.length >= 3 ? (parts[parts.length - 2] ?? null) : null
}

export function buildModel(details: NodeDetails, schema: ComponentSchema | null): InspectorModel {
  // JSX lets a later duplicate win and the engine edits the last occurrence, so the last one is
  // the value that matters.
  const byName = new Map<string, AttrDetails>()
  const order: string[] = []
  const spreads: string[] = []
  for (const attr of details.attributes) {
    if (attr.name === null) {
      spreads.push(attr.source)
      continue
    }
    if (!byName.has(attr.name)) order.push(attr.name)
    byName.set(attr.name, attr)
  }

  const schemaProps = schema?.props ?? []
  const known = new Set(schemaProps.map((p) => p.name))
  const props = schemaProps.filter((p) => p.kind !== 'className').map((p) => row(p.name, p, byName.get(p.name)))
  const extra = order
    .filter((name) => name !== 'className' && !known.has(name))
    .map((name) => row(name, null, byName.get(name)))

  const classAttr = byName.get('className')
  const acceptsClassName = schema === null || schemaProps.some((p) => p.kind === 'className') || classAttr !== undefined
  return {
    props,
    extra,
    spreads,
    className: acceptsClassName ? classNameState(classAttr) : null,
    written: new Set(order),
  }
}

function row(name: string, schema: PropSchema | null, attr: AttrDetails | undefined): PropRow {
  const value = valueState(attr)
  const declared = schema === null ? null : controlFor(schema)
  let control: Control | null = declared ?? (value.state === 'literal' ? inferControl(value.value) : null)
  let state = value
  if (control !== null && value.state === 'literal' && !accepts(control, value.value)) {
    // e.g. `disabled="yes"` on a boolean prop: show it, don't offer a setter that would retype it.
    state = { state: 'readonly', source: attr?.source ?? String(value.value), reason: 'mismatch' }
    control = null
  }
  if (state.state === 'readonly') control = null
  return { name, schema, control, value: state, defaultValue: schema?.default }
}

function valueState(attr: AttrDetails | undefined): ValueState {
  if (attr === undefined) return { state: 'absent' }
  const v = attr.value
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return { state: 'literal', value: v }
  return { state: 'readonly', source: attr.source, reason: attr.kind === 'element' ? 'element' : 'expression' }
}

function controlFor(schema: PropSchema): Control | null {
  switch (schema.kind) {
    case 'enum':
      // Radix Select reserves "" for "no value"; an empty option can't be offered as an item.
      return { kind: 'enum', options: schema.options.filter((o) => o !== '') }
    case 'boolean':
      return { kind: 'boolean' }
    case 'string':
      return { kind: 'string' }
    case 'number':
      return { kind: 'number' }
    case 'className':
    case 'unknown':
      return null
  }
}

function inferControl(value: Literal): Control {
  switch (typeof value) {
    case 'boolean':
      return { kind: 'boolean' }
    case 'number':
      return { kind: 'number' }
    case 'string':
      return { kind: 'string' }
  }
}

function accepts(control: Control, value: Literal): boolean {
  switch (control.kind) {
    case 'enum':
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number'
  }
}

function classNameState(attr: AttrDetails | undefined): ClassNameState {
  if (attr === undefined) return { state: 'absent' }
  // `className="…"` and `className={"…"}` are both a literal string the manager can rewrite.
  if (typeof attr.value === 'string') return { state: 'literal', value: attr.value }
  return { state: 'readonly', source: attr.source }
}

/** A JSX attribute name the engine accepts (`id`, `aria-label`, `data-state`, `xlink:href`). */
export function validatePropName(name: string, written: ReadonlySet<string>): string | null {
  if (name === '') return 'Enter a prop name'
  if (!/^[A-Za-z_$][\w$]*(?:[-:][\w$]+)*$/.test(name)) return `“${name}” is not a valid JSX attribute name`
  if (name === 'data-ast-node') return 'data-ast-node is managed by Trivia'
  if (written.has(name)) return `${name} is already set — edit it above`
  return null
}

/** The history label for an updateProp, e.g. "Set Button.variant" / "Remove Button.variant". */
export function propLabel(element: string, prop: string, value: JsonValue): string {
  return `${value === null ? 'Remove' : 'Set'} ${element}.${prop}`
}

/** How a JSON default reads in the UI (`"default"` → default, `false` → false). */
export function formatValue(value: JsonValue | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}
