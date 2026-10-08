// What Trivia knows about a Refine form page (docs/product.md, slice 2): a component calling
// `useForm` (@refinedev/react-hook-form) with a zod resolver. Its fields are three things that
// must agree: the zod schema's keys, `defaultValues`, and a react-hook-form `Controller` per
// field in the JSX. The contract is the request body of the create or update operation.

import type { ManifestField, ManifestResource, TriviaManifest } from '@trivia/contract-sync'

import { type FieldInfo, type ScopeValues, type ValueDesc, contractResource, fieldInfo, refineName } from './page.js'

export interface FormFieldInfo {
  name: string
  /** The `<FieldLabel>` text inside its Controller. */
  label: string | null
  /** The input it renders (`Input`, `Select`, `Checkbox`…). */
  widget: string | null
  /** Its Controller's `render` source. */
  renderSource: string | null
  /** Its Controller element, when the JSX has one. */
  control: { locator: string; line: number } | null
  /** Its zod rule as written, when the schema has the key. */
  rule: string | null
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
  /** In the order the form shows them (Controllers first, in source order), then schema-only keys. */
  fields: FormFieldInfo[]
  /** Request body fields the form doesn't have yet. */
  available: FieldInfo[]
  /** The element a new field's Controller goes into when there are none yet. */
  container: { locator: string; name: string } | null
}

/** A JSX element of the outline (engine `OutlineNode`). */
export interface OutlineNode {
  locator: string
  name: string
  line: number
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
        label: render.match(/<FieldLabel[^>]*>([^<{]+)<\/FieldLabel>/)?.[1]?.trim() ?? null,
        widget: render.match(/<(Input|Select|Checkbox|Switch|Textarea|RadioGroup|Combobox|Calendar)\b/)?.[1] ?? null,
        control: { locator: c.locator, line: c.line },
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
        hasDefault: defaultKeys.has(name),
        field: contractField ? fieldInfo(contractField) : null,
      }
    })
    const shown = new Set(fields.map((f) => f.name))
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

/** The Controllers a component renders, in source order. */
function controllersOf(outline: OutlineNode[], component: string): OutlineNode[] {
  const out: OutlineNode[] = []
  const walk = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      if (n.name === 'Controller') out.push(n)
      walk(n.children)
    }
  }
  walk(outline.filter((t) => t.locator.split('#').at(-2) === component))
  return out
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
