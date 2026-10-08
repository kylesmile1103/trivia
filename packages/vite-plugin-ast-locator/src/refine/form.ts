// What Trivia knows about a Refine form page (docs/product.md, slice 2): a component calling
// `useForm` (@refinedev/react-hook-form) with a zod resolver. Its fields are three things that
// must agree: the zod schema's keys, `defaultValues`, and a control per field in the JSX: a
// react-hook-form `Controller` (around shadcn's `Field`) or shadcn's `FormField` (slice 5). The
// contract is the request body of the create or update operation.

import type { ManifestField, ManifestResource, TriviaManifest } from '@trivia/contract-sync'

import type { FormStyle } from './fields.js'
import { type ChainCall, type FieldInfo, type ScopeValues, type ValueDesc, contractResource, fieldInfo, refineName } from './page.js'

/** The JSX elements a field's control can be. */
export const CONTROLS = ['Controller', 'FormField'] as const
export type ControlElement = (typeof CONTROLS)[number]

export interface FormFieldInfo {
  name: string
  /** The `<FieldLabel>` or `<FormLabel>` text inside its control. */
  label: string | null
  /** The input it renders (`Input`, `Select`, `Checkbox`…). */
  widget: string | null
  /** Its control's `render` source. */
  renderSource: string | null
  /**
   * Its control element, when the JSX has one. `direct` is false under a `{cond && …}` guard
   * or inside another expression: such a control is never an anchor for a new field.
   */
  control: { locator: string; line: number; element: ControlElement; direct: boolean; parent: { locator: string; name: string } | null } | null
  /** Its zod rule as written, when the schema has the key. */
  rule: string | null
  /** The rule's method chain (`z.string`, `max(100)`, `optional()`), when it is a call. */
  ruleChain: ChainCall[] | null
  /** The line of its key in the schema object. */
  ruleLine: number | null
  hasDefault: boolean
  /** The contract field it edits. */
  field: FieldInfo | null
}

export interface FormPage {
  kind: 'form'
  file: string
  component: string
  line: number
  action: 'create' | 'edit' | null
  resource: { name: string; from: 'refineCoreProps' | 'typeArgument' | 'folder' } | null
  /** The contract resource and the operation whose request body the form sends. */
  contract: { resource: string; operation: 'create' | 'update' } | null
  /** Value path of the zod object schema (via `zodResolver(…)`). */
  schemaPath: string | null
  /** Value path of `useForm({ defaultValues })`. */
  defaultsPath: string | null
  /** In the order the form shows them (controls first, in source order), then schema-only keys. */
  fields: FormFieldInfo[]
  /** The style its controls are written in (the more common one), or null when it has none. */
  style: FormStyle | null
  /** True when a `<Form>` (react-hook-form's provider, shadcn `form`) encloses the `<form>`. */
  provider: boolean
  /** Request body fields the form doesn't have yet. */
  available: FieldInfo[]
  /** The element a new field's control goes into when there are none yet. */
  container: { locator: string; name: string } | null
}

/** A JSX element of the outline (engine `OutlineNode`). */
export interface OutlineNode {
  locator: string
  name: string
  line: number
  /** False when rendered from a `{…}` expression, and for roots. */
  isDirect: boolean
  children: OutlineNode[]
}

export interface FormHost {
  outline(file: string): OutlineNode[]
  /** `name` and `render` attribute sources of an element. */
  attributes(locator: string): Array<{ name: string; source: string; value: unknown }>
}

function prop(obj: ValueDesc | undefined, key: string): ValueDesc | undefined {
  return obj?.kind === 'object' ? obj.properties.find((p) => p.key === key)?.value : undefined
}

/** Every form page in a file's values. */
export function formPages(file: string, scopes: ScopeValues[], manifest: TriviaManifest | null, host: FormHost): FormPage[] {
  const out: FormPage[] = []
  const module = scopes.find((s) => s.scope === 'module')
  let outline: OutlineNode[] | null = null
  for (const scope of scopes) {
    const call = scope.calls.find((c) => c.callee === 'useForm')
    const options = call?.args[0]
    if (!call || options?.kind !== 'object') continue
    const resolver = prop(options, 'resolver')
    const schemaName = resolver && 'source' in resolver ? resolver.source.match(/^zodResolver\(\s*([A-Za-z_$][\w$]*)\s*\)/)?.[1] : undefined
    if (!schemaName) continue
    const schema = scope.bindings.find((b) => b.name === schemaName) ?? module?.bindings.find((b) => b.name === schemaName)
    const core = prop(options, 'refineCoreProps')
    const action = prop(core, 'action')
    const resourceName = prop(core, 'resource')
    const rowType = call.typeArgs[0] ?? null
    const formAction: FormPage['action'] =
      action?.kind === 'string' && (action.value === 'create' || action.value === 'edit')
        ? action.value
        : /(^|\/)create\.[jt]sx$/.test(file)
          ? 'create'
          : /(^|\/)edit\.[jt]sx$/.test(file)
            ? 'edit'
            : null
    const byType = rowType ? manifest?.resources.find((r) => r.entity?.typeName === rowType) : undefined
    const resource: FormPage['resource'] =
      resourceName?.kind === 'string'
        ? { name: resourceName.value, from: 'refineCoreProps' }
        : byType
          ? { name: refineName(byType), from: 'typeArgument' }
          : folderOf(file)
    const matched = contractResource(manifest, resource?.name ?? null, rowType)
    const operation = formAction === 'edit' ? 'update' : 'create'
    const body = matched ? bodyFields(matched, operation) : null

    outline ??= host.outline(file)
    const controllers = controllersOf(outline, scope.scope).map((c) => {
      const attrs = host.attributes(c.locator)
      const name = attrs.find((a) => a.name === 'name')?.value
      const render = attrs.find((a) => a.name === 'render')?.source ?? ''
      return {
        name: typeof name === 'string' ? name : null,
        render: render || null,
        label: render.match(/<(?:FieldLabel|FormLabel)\b[^>]*>([^<{]+)<\/(?:FieldLabel|FormLabel)>/)?.[1]?.trim() ?? null,
        widget: render.match(/<(Input|Select|Checkbox|Switch|Textarea|RadioGroup|Combobox|Calendar)\b/)?.[1] ?? null,
        control: { locator: c.locator, line: c.line, element: c.name as ControlElement, direct: c.isDirect, parent: c.parent },
      }
    })
    const schemaKeys = schema?.value.kind === 'object' ? schema.value.properties.filter((p) => p.key !== '...') : []
    const defaults = prop(options, 'defaultValues')
    const defaultKeys = new Set(defaults?.kind === 'object' ? defaults.properties.map((p) => p.key) : [])
    const names = [...controllers.map((c) => c.name).filter((n): n is string => n !== null), ...schemaKeys.map((p) => p.key)]
    const fields: FormFieldInfo[] = [...new Set(names)].map((name) => {
      const control = controllers.find((c) => c.name === name)
      const rule = schemaKeys.find((p) => p.key === name)?.value
      const contractField = body?.find((f) => f.name === name)
      return {
        name,
        label: control?.label ?? null,
        widget: control?.widget ?? null,
        renderSource: control?.render ?? null,
        control: control?.control ?? null,
        rule: rule ? sourceOf(rule) : null,
        ruleChain: rule?.kind === 'call' ? rule.chain : null,
        ruleLine: schemaKeys.find((p) => p.key === name)?.line ?? null,
        hasDefault: defaultKeys.has(name),
        field: contractField ? fieldInfo(contractField) : null,
      }
    })
    const shown = new Set(fields.map((f) => f.name))
    const fieldStyle = controllers.filter((c) => c.control.element === 'Controller').length
    const formStyle = controllers.length - fieldStyle
    out.push({
      kind: 'form',
      file,
      component: scope.scope,
      line: call.line,
      action: formAction,
      resource,
      contract: matched && body ? { resource: matched.name, operation } : null,
      schemaPath: schema?.value.kind === 'object' ? schema.path : null,
      defaultsPath: defaults?.kind === 'object' ? `${call.path}.defaultValues` : null,
      fields,
      style: controllers.length === 0 ? null : formStyle > fieldStyle ? 'form' : 'field',
      provider: hasProvider(outline, scope.scope),
      available: (body ?? []).filter((f) => !f.readOnly && !shown.has(f.name)).map(fieldInfo),
      container: containerOf(outline, scope.scope),
    })
  }
  return out
}

function folderOf(file: string): FormPage['resource'] {
  const folder = file.split('/').slice(-2, -1)[0]
  return folder && folder !== 'pages' && folder !== 'src' ? { name: folder, from: 'folder' } : null
}

/** The fields of an operation's request body. */
export function bodyFields(resource: ManifestResource, operation: 'create' | 'update'): ManifestField[] | null {
  const op = resource.operations[operation] as { requestBody?: { fields?: ManifestField[] | null } | null } | null
  return op?.requestBody?.fields ?? null
}

function sourceOf(v: ValueDesc): string {
  switch (v.kind) {
    case 'string':
      return JSON.stringify(v.value)
    case 'number':
    case 'boolean':
      return String(v.value)
    case 'null':
      return 'null'
    case 'identifier':
      return v.name
    case 'object':
    case 'array':
      return v.kind
    default:
      return v.source
  }
}

/** The field controls (`Controller`, `FormField`) a component renders, in source order, with their parent element. */
function controllersOf(outline: OutlineNode[], component: string): Array<OutlineNode & { parent: { locator: string; name: string } | null }> {
  const out: Array<OutlineNode & { parent: { locator: string; name: string } | null }> = []
  const walk = (nodes: OutlineNode[], parent: OutlineNode | null) => {
    for (const n of nodes) {
      if ((CONTROLS as readonly string[]).includes(n.name)) out.push({ ...n, parent: parent ? { locator: parent.locator, name: parent.name } : null })
      walk(n.children, n)
    }
  }
  walk(
    outline.filter((t) => t.locator.split('#').at(-2) === component),
    null,
  )
  return out
}

/** True when a `<Form>` provider encloses the component's `<form>`. */
function hasProvider(outline: OutlineNode[], component: string): boolean {
  const walk = (nodes: OutlineNode[], inForm: boolean): boolean =>
    nodes.some((n) => (n.name === 'form' && inForm) || walk(n.children, inForm || n.name === 'Form'))
  return walk(
    outline.filter((t) => t.locator.split('#').at(-2) === component),
    false,
  )
}

/** Where a first field goes: the form's `FieldGroup`, else its `<form>`. */
function containerOf(outline: OutlineNode[], component: string): FormPage['container'] {
  let group: OutlineNode | null = null
  let form: OutlineNode | null = null
  const walk = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      if (n.name === 'FieldGroup' && !group) group = n
      if (n.name === 'form' && !form) form = n
      walk(n.children)
    }
  }
  walk(outline.filter((t) => t.locator.split('#').at(-2) === component))
  const pick = (group ?? form) as OutlineNode | null
  return pick ? { locator: pick.locator, name: pick.name } : null
}
