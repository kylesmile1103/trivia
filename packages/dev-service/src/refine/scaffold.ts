// New pages for a contract resource (docs/product.md, slice 4): list, create, edit and show, as
// whole files written the way Refine's shadcn pages are (and the way slices 1–2 edit them), so
// the panels can keep working on them afterwards. Columns and fields come from columns.ts and
// fields.ts, the same code that adds one to an existing page.

import type { ContractOptions } from '@trivia/blueprint'
import type { ContractPageInput, RefineSnippetGenerator } from '@trivia/blueprint-compiler'
import type { ManifestField, ManifestResource } from '@trivia/contract-sync'

import { type ImportSpec, columnFor, fieldShape, humanize } from './columns.js'
import { type FieldContext, type FormStyle, formFieldFor, kebab } from './fields.js'
import { bodyFields } from './form.js'
import { refineName } from './page.js'

export type PageKind = 'list' | 'create' | 'edit' | 'show'
export const PAGE_KINDS: readonly PageKind[] = ['list', 'create', 'edit', 'show']

export interface ScaffoldContext {
  /** shadcn ui import prefix, e.g. `@/components/ui`. */
  ui: string
  /** refine-ui import prefix, e.g. `@/components/refine-ui`; null when the project has none. */
  refineUi: string | null
  /** Module of the generated types (manifest `modules.types.importPath`). */
  typesImport: string
  /** Where pages go, and their import prefix: `src/pages`, `@/pages`. */
  pagesDir: string
  pagesImport: string
  /** App Router pages are client entry points and register by filename. */
  appRouter?: true
  /** The project has shadcn's `textarea`. */
  textarea?: boolean
  /** How forms write fields (`fields.ts` FormStyle); default `field`. */
  style?: FormStyle
}

type RenderContext = ScaffoldContext & NonNullable<ScaffoldRequest['options']> & Pick<ScaffoldRequest, 'actions'>

export interface ScaffoldRequest {
  resource: ManifestResource
  kind: PageKind
  project: ScaffoldContext
  options?: Pick<ContractOptions, 'fields' | 'hideFields' | 'title' | 'filters'>
  actions?: ContractPageInput['actions']
}

export type RefinePageGenerator = (request: ScaffoldRequest) => PageFile

/** `resource` without the fields named in `hide`: in its entity and in its request bodies. */
function withoutFields(resource: ManifestResource, hide: readonly string[]): ManifestResource {
  if (hide.length === 0) return resource
  const keep = <T extends { name: string }>(fields: T[]): T[] => fields.filter((f) => !hide.includes(f.name))
  const body = <O extends { requestBody: { fields: ManifestField[] | null } | null } | null>(op: O): O =>
    op && op.requestBody?.fields ? { ...op, requestBody: { ...op.requestBody, fields: keep(op.requestBody.fields) } } : op
  return {
    ...resource,
    entity: resource.entity ? { ...resource.entity, fields: keep(resource.entity.fields) } : null,
    operations: { ...resource.operations, create: body(resource.operations.create), update: body(resource.operations.update) },
  }
}

/** Keep the blueprint's explicit field order, without duplicating a column or control. */
function selectedFields(fields: readonly ManifestField[], selection?: readonly string[]): ManifestField[] {
  if (selection === undefined) return [...fields]
  const byName = new Map(fields.map((field) => [field.name, field]))
  return [...new Set(selection)].flatMap((name) => byName.get(name) ?? [])
}

export interface PageFile {
  kind: PageKind
  file: string
  importPath: string
  component: string
  /** The route path Refine conventionally gives it. */
  route: string
  content: string
}

/** Most columns a generated list shows. */
const MAX_LIST_COLUMNS = 6
const SCALAR = new Set(['text', 'enum', 'number', 'date', 'dateTime', 'boolean'])

/** The page kinds the contract supports for a resource. */
export function supportedKinds(resource: ManifestResource): PageKind[] {
  const ops = resource.operations
  const kinds: PageKind[] = []
  if (ops.list && resource.entity) kinds.push('list')
  if (ops.create && bodyFields(resource, 'create')) kinds.push('create')
  if (ops.update && bodyFields(resource, 'update')) kinds.push('edit')
  if (ops.get && resource.entity) kinds.push('show')
  return kinds
}

export function routeOf(name: string, kind: PageKind): string {
  return kind === 'list' ? `/${name}` : kind === 'create' ? `/${name}/create` : `/${name}/${kind}/:id`
}

/** Collects imports and writes them as the hand-written pages do: packages, a blank line, then `@/…`. */
class Imports {
  readonly #named = new Map<string, Set<string>>()
  readonly #types = new Map<string, Set<string>>()
  readonly #extra: string[] = []

  add(spec: ImportSpec): void {
    const set = this.#named.get(spec.source) ?? new Set<string>()
    set.add(spec.name)
    this.#named.set(spec.source, set)
  }

  type(name: string, source: string): void {
    const set = this.#types.get(source) ?? new Set<string>()
    set.add(name)
    this.#types.set(source, set)
  }

  /** A line as is, e.g. `import * as z from "zod";`. */
  line(text: string): void {
    this.#extra.push(text)
  }

  render(): string {
    const lines: Array<{ source: string; text: string }> = []
    const list = (names: Set<string>) => {
      const sorted = [...names].sort((a, b) => a.localeCompare(b))
      return sorted.length > 3 ? `{\n${sorted.map((n) => `  ${n},`).join('\n')}\n}` : `{ ${sorted.join(', ')} }`
    }
    for (const [source, names] of this.#types) lines.push({ source, text: `import type ${list(names)} from "${source}";` })
    for (const [source, names] of this.#named) lines.push({ source, text: `import ${list(names)} from "${source}";` })
    for (const text of this.#extra) lines.push({ source: text.match(/from "([^"]+)"/)?.[1] ?? '', text })
    const local = (s: string) => s.startsWith('@/') || s.startsWith('.')
    const sort = (a: { source: string }, b: { source: string }) => a.source.localeCompare(b.source)
    const packages = lines.filter((l) => !local(l.source)).sort(sort)
    const ours = lines.filter((l) => local(l.source)).sort(sort)
    return [...packages.map((l) => l.text), ...(packages.length && ours.length ? [''] : []), ...ours.map((l) => l.text)].join('\n')
  }
}

const indent = (text: string, by: number) =>
  text
    .split('\n')
    .map((line) => (line ? ' '.repeat(by) + line : line))
    .join('\n')

/** `text` as a JSX attribute value: `"…"`, or `{"…"}` when it holds what a JSX string can't escape. */
const attr = (text: string) => (/^[^"\\\n{}<>&]*$/.test(text) ? `"${text}"` : `{${JSON.stringify(text)}}`)

const camel = (name: string) => name.charAt(0).toLowerCase() + name.slice(1)

export function generateRefineSnippets(
  project: Pick<ScaffoldContext, 'ui' | 'refineUi' | 'textarea' | 'style'>,
  fieldOptions: Pick<FieldContext, 'datePicker' | 'describeErrors'> = {},
): RefineSnippetGenerator {
  const { ui, refineUi, textarea = false, style = 'field' } = project
  return {
    column: (field, filter) => columnFor(field, {
      badge: ui + '/badge', dataTable: refineUi ? refineUi + '/data-table' : null, filter,
    }),
    field: (field, idPrefix) => formFieldFor(field, { ui, textarea, style, idPrefix, ...fieldOptions }),
  }
}

/** The same generator is used by the new-resource plan, inferencer and blueprint compiler. */
export const generateRefinePage: RefinePageGenerator = ({ resource: contract, kind, project, options, actions }) => {
  const name = refineName(contract)
  const typeName = contract.entity?.typeName ?? null
  const supported = supportedKinds(contract)
  if (!supported.includes(kind)) {
    throw new Error(`${contract.name} has no ${kind === 'edit' ? 'update' : kind === 'show' ? 'get' : kind} operation in the contract`)
  }
  const resource = withoutFields(contract, options?.hideFields ?? [])
  const context: RenderContext = { ...project, ...options, actions }
  const component = `${resource.name}${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
  const route = routeOf(name, kind)
  const file = context.appRouter
    ? `${context.pagesDir}${route.replace('/:id', '/[id]')}/page.tsx`
    : `${context.pagesDir}/${name}/${kind}.tsx`
  const importPath = context.appRouter ? file.slice(0, -'.tsx'.length) : `${context.pagesImport}/${name}/${kind}`
  let content: string
  switch (kind) {
    case 'list':
      content = listPage(resource, name, component, typeName, supported, context)
      break
    case 'create':
    case 'edit':
      content = formPage(resource, name, component, typeName, kind, context)
      break
    case 'show':
      content = showPage(resource, name, component, typeName, context)
      break
  }
  if (context.appRouter) content = `"use client";\n\n${content.replace(`export function ${component}`, `export default function ${component}`)}`
  return { kind, file, importPath, component, route, content }
}

function actionSetup(context: RenderContext, imports: Imports): string {
  if (!context.actions) return ''
  imports.add({ name: 'Button', source: context.ui + '/button' })
  for (const spec of context.actions.imports) {
    const name = spec.as ? spec.name + ' as ' + spec.as : spec.name
    if (spec.kind === 'type') imports.type(name, spec.source)
    else imports.add({ source: spec.source, name })
  }
  return '\n' + indent(context.actions.setup, 2) + '\n'
}

function headerActions(context: RenderContext): string {
  const header = context.actions?.header ?? []
  if (!header.length) return ''
  return '\n      <div className="flex justify-end gap-2">\n'
    + header.map((line) => indent(line, 8)).join('\n') + '\n      </div>'
}

function listPage(
  resource: ManifestResource,
  name: string,
  component: string,
  typeName: string | null,
  supported: PageKind[],
  context: RenderContext,
): string {
  const imports = new Imports()
  const row = typeName ?? 'Record<string, unknown>'
  if (typeName) imports.type(typeName, context.typesImport)
  imports.add({ name: 'useMemo', source: 'react' })
  imports.add({ name: 'useTable', source: '@refinedev/react-table' })
  imports.type('ColumnDef', '@tanstack/react-table')
  const refineUi = context.refineUi ?? '@/components/refine-ui'
  imports.add({ name: 'DataTable', source: `${refineUi}/data-table/data-table` })
  imports.add({ name: 'ListView', source: `${refineUi}/views/list-view` })
  imports.add({ name: 'ListViewHeader', source: `${refineUi}/views/list-view` })

  const fields = resource.entity?.fields ?? []
  const visible = context.fields === undefined
    ? fields.filter((f) => f.name !== resource.primaryKey && SCALAR.has(fieldShape(f))).slice(0, MAX_LIST_COLUMNS)
    : selectedFields(fields, context.fields)
  const snippets = generateRefineSnippets(context)
  const columns = visible.map((f) => {
    const column = snippets.column(f, context.filters?.includes(f.name) ?? true)
    for (const spec of column.imports) imports.add(spec)
    return column.value
  })
  const actions: string[] = [...(context.actions?.row ?? [])]
  const id = resource.primaryKey ?? 'id'
  if (supported.includes('edit')) {
    imports.add({ name: 'EditButton', source: `${refineUi}/buttons/edit` })
    actions.push(`<EditButton recordItemId={row.original.${id}} size="sm" variant="ghost" />`)
  }
  if (supported.includes('show')) {
    imports.add({ name: 'ShowButton', source: `${refineUi}/buttons/show` })
    actions.push(`<ShowButton recordItemId={row.original.${id}} size="sm" variant="ghost" />`)
  }
  if (actions.length > 0) {
    columns.push(
      [
        '{',
        '  id: "actions",',
        '  header: "",',
        '  enableSorting: false,',
        '  cell: ({ row }) => (',
        `    <div className="flex ${context.actions?.row.length ? 'flex-wrap ' : ''}justify-end gap-1">`,
        ...actions.map((a) => `      ${a}`),
        '    </div>',
        '  ),',
        '}',
      ].join('\n'),
    )
  }
  const setup = actionSetup(context, imports)
  return `${imports.render()}

export function ${component}() {${setup}
  const columns = useMemo<ColumnDef<${row}>[]>(
    () => [
${columns.map((c) => `${indent(c, 6)},`).join('\n')}
    ],
    [${context.actions?.dependencies.join(', ') ?? ''}],
  );

  const table = useTable<${row}>({
    columns,
    refineCoreProps: {
      resource: "${name}",
    },
  });

  return (
    <ListView>
      <ListViewHeader title=${attr(context.title ?? humanize(name))} />${headerActions(context)}
      <DataTable table={table} />
    </ListView>
  );
}
`
}

function formPage(
  resource: ManifestResource,
  name: string,
  component: string,
  typeName: string | null,
  kind: 'create' | 'edit',
  context: RenderContext,
): string {
  const imports = new Imports()
  const body = selectedFields(bodyFields(resource, kind === 'create' ? 'create' : 'update') ?? [], context.fields).filter((f) => !f.readOnly)
  const editable = body.filter((f) => SCALAR.has(fieldShape(f)))
  const skipped = body.filter((f) => !SCALAR.has(fieldShape(f)))
  const schema = `${camel(resource.name)}Schema`
  const values = `${resource.name}FormValues`
  const refineUi = context.refineUi ?? '@/components/refine-ui'
  imports.add({ name: 'zodResolver', source: '@hookform/resolvers/zod' })
  imports.type('HttpError', '@refinedev/core')
  imports.add({ name: 'useForm', source: '@refinedev/react-hook-form' })
  imports.line('import * as z from "zod";')
  if (typeName) imports.type(typeName, context.typesImport)
  const View = kind === 'create' ? 'CreateView' : 'EditView'
  imports.add({ name: View, source: `${refineUi}/views/${kind}-view` })
  imports.add({ name: `${View}Header`, source: `${refineUi}/views/${kind}-view` })
  imports.add({ name: 'Button', source: `${context.ui}/button` })
  const style = context.style ?? 'field'
  // `FormField` reads the form from `<Form>`'s context; `Field`s sit in a `FieldGroup`.
  imports.add(style === 'form' ? { name: 'Form', source: `${context.ui}/form` } : { name: 'FieldGroup', source: `${context.ui}/field` })

  const snippets = generateRefineSnippets(context)
  const pieces = editable.map((f: ManifestField) => {
    const piece = snippets.field(f, kebab(resource.name))
    for (const spec of piece.imports) imports.add(spec)
    return { name: f.name, ...piece }
  })
  const key = (n: string) => (/^[A-Za-z_$][\w$]*$/.test(n) ? n : JSON.stringify(n))
  const submit = kind === 'create' ? `Create ${humanize(resource.name).toLowerCase()}` : 'Save changes'
  const skippedNote = (at: number) => skipped.map((f) => `\n${' '.repeat(at)}{/* ${f.name} (${f.type}): not generated; add its fields by hand */}`).join('')
  const button = (at: number) =>
    [`<Button type="submit" disabled={formLoading} className="justify-self-start">`, `  ${submit}`, `</Button>`].map((l) => ' '.repeat(at) + l).join('\n')
  const formJsx =
    style === 'form'
      ? `      <Form {...form}>
        <form
          noValidate
          onSubmit={form.handleSubmit((values) => onFinish(values).catch(console.error))}
          className="grid max-w-xl gap-6"
        >
${pieces.map((p) => indent(p.controller, 10)).join('\n')}${skippedNote(10)}
${button(10)}
        </form>
      </Form>`
      : `      <form
        noValidate
        onSubmit={form.handleSubmit((values) => onFinish(values).catch(console.error))}
        className="grid max-w-xl gap-6"
      >
        <FieldGroup>
${pieces.map((p) => indent(p.controller, 10)).join('\n')}${skippedNote(10)}
        </FieldGroup>
${button(8)}
      </form>`
  const setup = actionSetup(context, imports)
  return `${imports.render()}

const ${schema} = z.object({
${pieces.map((p) => `  ${key(p.name)}: ${p.rule},`).join('\n')}
});

type ${values} = z.infer<typeof ${schema}>;

export function ${component}() {${setup}
  const {
    refineCore: { onFinish, formLoading },
    ...form
  } = useForm<${typeName ?? 'Record<string, unknown>'}, HttpError, ${values}>({
    resolver: zodResolver(${schema}),
    defaultValues: {
${pieces.map((p) => `      ${key(p.name)}: ${p.defaultValue},`).join('\n')}
    },
    refineCoreProps: {
      resource: "${name}",
      action: "${kind}",
      redirect: "list",
    },
  });

  return (
    <${View}>
      <${View}Header${context.title ? ` title=${attr(context.title)}` : ''} />${headerActions(context)}
${formJsx}
    </${View}>
  );
}
`
}

function showPage(resource: ManifestResource, name: string, component: string, typeName: string | null, context: RenderContext): string {
  const imports = new Imports()
  const refineUi = context.refineUi ?? '@/components/refine-ui'
  imports.add({ name: 'useShow', source: '@refinedev/core' })
  if (typeName) imports.type(typeName, context.typesImport)
  imports.add({ name: 'ShowView', source: `${refineUi}/views/show-view` })
  imports.add({ name: 'ShowViewHeader', source: `${refineUi}/views/show-view` })
  const fields = selectedFields(resource.entity?.fields ?? [], context.fields)
  const rows = fields.map((f) => {
    const shape = fieldShape(f)
    const value = `record?.${f.name}`
    let render: string
    switch (shape) {
      case 'enum':
        imports.add({ name: 'Badge', source: `${context.ui}/badge` })
        render = `{${value} ? <Badge variant="secondary">{${value}}</Badge> : "—"}`
        break
      case 'date':
        render = `{${value} ? new Date(${value}).toLocaleDateString() : "—"}`
        break
      case 'dateTime':
        render = `{${value} ? new Date(${value}).toLocaleString() : "—"}`
        break
      case 'number':
        render = `{${value}?.toLocaleString() ?? "—"}`
        break
      case 'boolean':
        render = `{${value} === undefined ? "—" : ${value} ? "Yes" : "No"}`
        break
      case 'text':
        render = `{${value} ?? "—"}`
        break
      default:
        render = `{${value} === undefined ? "—" : JSON.stringify(${value})}`
    }
    return `        <dt className="text-muted-foreground">${humanize(f.name)}</dt>\n        <dd>${render}</dd>`
  })
  const setup = actionSetup(context, imports)
  return `${imports.render()}

export function ${component}() {${setup}
  const { result: record } = useShow<${typeName ?? 'Record<string, unknown>'}>({
    resource: "${name}",
  });

  return (
    <ShowView>
      <ShowViewHeader${context.title ? ` title=${attr(context.title)}` : ''} />${headerActions(context)}
      <dl className="grid max-w-xl grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
${rows.join('\n')}
      </dl>
    </ShowView>
  );
}
`
}
