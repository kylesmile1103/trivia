// The code the Data panel adds to the user's project, as source text: a generic DataTable
// component (once per project) and a create form per resource. It is written in the user's
// stack: their shadcn components (by their own import paths), the hey-api code contract-sync
// generated (TanStack Query factories, zod schemas) and react-hook-form. Every name in it comes
// from trivia.manifest.json or the component library, never from guessing.

import type { ComponentSchema, ManifestField, ManifestModule, ManifestResource, TriviaManifest } from '@/shared/engine/types'
import type { Template } from '@/shared/template'

export interface CodegenContext {
  manifest: TriviaManifest
  /** The user's components by name; `importSource` says where each lives. */
  components: Readonly<Record<string, ComponentSchema>>
  /** Project-relative directory of the user's own components, e.g. "src/components". */
  componentsDir: string
  /** Import prefix for that directory, e.g. "@/components". */
  componentsImport: string
}

/** A file the Data panel creates, and how a page imports it. */
export interface GeneratedFile {
  file: string
  importPath: string
  content: string
}

/** "fullName" → "Full name", "kycStatus" → "Kyc status", "created_at" → "Created at". */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** "Customer" → "customer", "OrderLine" → "order-line". */
export function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** How `fromFile` imports `module`: its alias path, or a relative one when it has none. */
export function importOf(module: ManifestModule, fromFile: string): string {
  if (module.importPath !== null) return module.importPath
  const from = fromFile.split('/').slice(0, -1)
  const to = module.file.replace(/\.tsx?$/, '').split('/')
  let common = 0
  while (common < from.length && from[common] === to[common]) common++
  const rel = [...Array(from.length - common).fill('..'), ...to.slice(common)].join('/')
  return rel.startsWith('..') ? rel : `./${rel}`
}

// ---------------------------------------------------------------------------------------------
// DataTable

export function dataTableFile(ctx: CodegenContext): GeneratedFile {
  const table = ctx.components['Table']
  const [Table, Header, Body, Row, Head, Cell] = table
    ? ['Table', 'TableHeader', 'TableBody', 'TableRow', 'TableHead', 'TableCell']
    : ['table', 'thead', 'tbody', 'tr', 'th', 'td']
  const tableOpen = table ? '<Table>' : '<table className="w-full caption-bottom text-sm">'
  const head = table ? 'TableHead' : 'th className="h-10 px-2 text-left font-medium"'
  const cell = table ? 'TableCell' : 'td className="p-2"'
  const imports = table
    ? [`import {`, `  Table,`, `  TableBody,`, `  TableCell,`, `  TableHead,`, `  TableHeader,`, `  TableRow,`, `} from "${table.importSource}"`, ``]
    : []
  const content = [
    ...imports,
    `/** One column of a DataTable: the row property it shows, and its header. */`,
    `export interface DataTableColumn<Row> {`,
    `  key: keyof Row & string`,
    `  header: string`,
    `}`,
    ``,
    `/** Rows as a table. Added by Trivia's Data panel; edit it freely (Trivia never overwrites it). */`,
    `export function DataTable<Row>({`,
    `  columns,`,
    `  data = [],`,
    `  isLoading = false,`,
    `}: {`,
    `  columns: DataTableColumn<Row>[]`,
    `  data?: Row[]`,
    `  isLoading?: boolean`,
    `}) {`,
    `  return (`,
    `    ${tableOpen}`,
    `      <${Header}>`,
    `        <${Row}>`,
    `          {columns.map((column) => (`,
    `            <${head} key={column.key}>{column.header}</${Head}>`,
    `          ))}`,
    `        </${Row}>`,
    `      </${Header}>`,
    `      <${Body}>`,
    `        {isLoading ? (`,
    `          <${Row}>`,
    `            <${cell} colSpan={columns.length}>Loading…</${Cell}>`,
    `          </${Row}>`,
    `        ) : data.length === 0 ? (`,
    `          <${Row}>`,
    `            <${cell} colSpan={columns.length}>No rows.</${Cell}>`,
    `          </${Row}>`,
    `        ) : (`,
    `          data.map((row, index) => (`,
    `            <${Row} key={index}>`,
    `              {columns.map((column) => (`,
    `                <${cell} key={column.key}>{display(row[column.key])}</${Cell}>`,
    `              ))}`,
    `            </${Row}>`,
    `          ))`,
    `        )}`,
    `      </${Body}>`,
    `    </${Table}>`,
    `  )`,
    `}`,
    ``,
    `function display(value: unknown): string {`,
    `  if (value === null || value === undefined) return "—"`,
    `  if (typeof value === "object") return JSON.stringify(value)`,
    `  return String(value)`,
    `}`,
    ``,
  ].join('\n')
  return { file: `${ctx.componentsDir}/data-table.tsx`, importPath: `${ctx.componentsImport}/data-table`, content }
}

const SCALAR = new Set(['string', 'number', 'integer', 'boolean'])
const MAX_COLUMNS = 5

/** The columns a table starts with: up to five scalar fields of the entity, its key left out. */
export function tableColumns(resource: ManifestResource): ManifestField[] {
  return (resource.entity?.fields ?? []).filter((f) => SCALAR.has(f.type) && f.name !== resource.primaryKey).slice(0, MAX_COLUMNS)
}

/** A DataTable bound to the resource's list query, or why there can't be one. */
export function tableTemplate(resource: ManifestResource, ctx: CodegenContext): Template | string {
  const list = resource.operations.list
  if (!list?.queryOptionsFn) return 'it has no list operation'
  const columns = tableColumns(resource)
  if (columns.length === 0) return 'its rows have no plain fields to show'
  const component = dataTableFile(ctx)
  const optionsImport = ctx.manifest.modules.queries.importPath
  if (optionsImport === null) return 'the generated code is outside the import alias (re-run contract-sync with --import-alias)'
  const snippet = [
    '<DataTable',
    '  columns={[',
    ...columns.map((f) => `    { key: ${JSON.stringify(f.name)}, header: ${JSON.stringify(humanize(f.name))} },`),
    '  ]}',
    '/>',
  ].join('\n')
  return {
    component: 'DataTable',
    label: `${resource.name} table`,
    snippet,
    imports: [{ name: 'DataTable', source: component.importPath }],
    before: [{ op: 'createFile', file: component.file, content: component.content, ifMissing: true }],
    bind: {
      optionsFn: list.queryOptionsFn,
      optionsImport,
      resource: resource.name,
      itemsPath: list.listItemsPath ?? null,
      dataProp: 'data',
      loadingProp: 'isLoading',
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Create form

const NEEDED = ['Field', 'Input', 'Button'] as const

/** The create form component for `resource`, or why it can't be generated. */
export function formFile(resource: ManifestResource, ctx: CodegenContext): (GeneratedFile & { component: string }) | string {
  const create = resource.operations.create
  const body = create?.requestBody
  if (!create || !create.mutationFn) return 'it has no create operation'
  if (!body?.fields) return 'its create body is not an object'
  const zodModule = ctx.manifest.modules.zod
  if (!body.zodSchema || zodModule === null) return 'the contract was generated without zod (run contract-sync with --zod)'
  const missing = NEEDED.filter((name) => !ctx.components[name])
  if (missing.length > 0) return `it needs shadcn ${missing.map((m) => m.toLowerCase()).join(', ')} (npx shadcn add ${missing.map((m) => m.toLowerCase()).join(' ')})`

  const component = `${resource.name}CreateForm`
  const file = `${ctx.componentsDir}/forms/${kebab(resource.name)}-create-form.tsx`
  const id = kebab(resource.name)
  const fields = body.fields.filter((f) => !f.readOnly)
  const editable = fields.filter((f) => SCALAR.has(f.type))
  const skipped = fields.filter((f) => !SCALAR.has(f.type))
  const listKey = resource.operations.list?.queryKeyFn ?? null
  const queries = importOf(ctx.manifest.modules.queries, file)
  const zod = importOf(zodModule, file)
  const ui = (name: string) => ctx.components[name]?.importSource ?? `${ctx.componentsImport}/ui/${kebab(name)}`

  const usesSelect = editable.some((f) => isStringEnum(f)) && ctx.components['Select'] !== undefined
  const usesCheckbox = editable.some((f) => f.type === 'boolean') && ctx.components['Checkbox'] !== undefined
  const queryHooks = listKey ? 'useMutation, useQueryClient' : 'useMutation'
  const lines: string[] = [
    `import { zodResolver } from "@hookform/resolvers/zod"`,
    `import { ${queryHooks} } from "@tanstack/react-query"`,
    `import { Controller, useForm } from "react-hook-form"`,
    ``,
    `import { ${[create.mutationFn, listKey].filter(Boolean).join(', ')} } from "${queries}"`,
    `import { ${body.zodSchema} } from "${zod}"`,
    `import { Button } from "${ui('Button')}"`,
    ...(usesCheckbox ? [`import { Checkbox } from "${ui('Checkbox')}"`] : []),
    `import { Field, FieldError, FieldGroup, FieldLabel } from "${ui('Field')}"`,
    `import { Input } from "${ui('Input')}"`,
    ...(usesSelect ? [`import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "${ui('Select')}"`] : []),
    ``,
    `/** Creates a ${resource.name} through ${create.method} ${create.path}. Added by Trivia's Data panel; edit it freely. */`,
    `export function ${component}() {`,
    ...(listKey ? [`  const queryClient = useQueryClient()`] : []),
    `  const form = useForm({`,
    `    resolver: zodResolver(${body.zodSchema}),`,
    `    defaultValues: { ${editable.filter((f) => f.required && f.type === 'string' && !isStringEnum(f)).map((f) => `${f.name}: ""`).join(', ')} },`,
    `  })`,
    `  const mutation = useMutation({`,
    `    ...${create.mutationFn}(),`,
    `    onSuccess: () => {`,
    `      form.reset()`,
    ...(listKey ? [`      return queryClient.invalidateQueries({ queryKey: ${listKey}() })`] : []),
    `    },`,
    `  })`,
    ``,
    `  return (`,
    // noValidate: the zod schema validates, with the same messages for every field, instead of
    // the browser's own checks of type="email" and friends getting there first.
    `    <form noValidate onSubmit={form.handleSubmit((body) => mutation.mutate({ body }))} className="grid gap-4">`,
    `      <FieldGroup>`,
    ...editable.flatMap((f) => controller(f, `${id}-${kebab(f.name)}`, { usesSelect, usesCheckbox })),
    ...skipped.map((f) => `        {/* ${f.name} (${f.type}): not generated; add its fields by hand */}`),
    `      </FieldGroup>`,
    `      <Button type="submit" disabled={mutation.isPending}>`,
    `        Create ${humanize(resource.name).toLowerCase()}`,
    `      </Button>`,
    `      {mutation.isError && <p role="alert" className="text-sm text-destructive">Couldn’t create the ${humanize(resource.name).toLowerCase()}.</p>}`,
    `      {mutation.isSuccess && <p className="text-sm text-muted-foreground">${humanize(resource.name)} created.</p>}`,
    `    </form>`,
    `  )`,
    `}`,
    ``,
  ]
  return { file, importPath: `${ctx.componentsImport}/forms/${kebab(resource.name)}-create-form`, component, content: lines.join('\n') }
}

function isStringEnum(f: ManifestField): boolean {
  return f.type === 'string' && f.enum !== null && f.enum.every((v) => typeof v === 'string')
}

/** One field: a react-hook-form Controller around a shadcn Field. */
function controller(f: ManifestField, id: string, has: { usesSelect: boolean; usesCheckbox: boolean }): string[] {
  const label = `${humanize(f.name)}${f.required ? ' *' : ''}`
  // An optional field left empty is absent, not "" (which a format check would refuse).
  const emptyIsAbsent = f.required ? '' : ' || undefined'
  let input: string[]
  if (isStringEnum(f) && has.usesSelect) {
    input = [
      `<Select value={field.value ?? ""} onValueChange={field.onChange}>`,
      `  <SelectTrigger id="${id}" aria-invalid={fieldState.invalid}>`,
      `    <SelectValue placeholder="Choose…" />`,
      `  </SelectTrigger>`,
      `  <SelectContent>`,
      ...(f.enum as string[]).map((v) => `    <SelectItem value=${JSON.stringify(v)}>${humanize(v)}</SelectItem>`),
      `  </SelectContent>`,
      `</Select>`,
    ]
  } else if (f.type === 'boolean' && has.usesCheckbox) {
    input = [`<Checkbox id="${id}" checked={field.value ?? false} onCheckedChange={(checked) => field.onChange(checked === true)} />`]
  } else if (f.type === 'number' || f.type === 'integer') {
    input = [
      `<Input`,
      `  {...field}`,
      `  id="${id}"`,
      `  type="number"`,
      `  value={field.value ?? ""}`,
      `  onChange={(e) => field.onChange(e.target.value === "" ? undefined : e.target.valueAsNumber)}`,
      `  aria-invalid={fieldState.invalid}`,
      `/>`,
    ]
  } else {
    const type = f.format === 'email' ? 'email' : f.format === 'date' ? 'date' : f.format === 'uri' || f.format === 'url' ? 'url' : null
    input = [
      `<Input`,
      `  {...field}`,
      `  id="${id}"`,
      ...(type ? [`  type="${type}"`] : []),
      `  value={field.value ?? ""}`,
      `  onChange={(e) => field.onChange(e.target.value${emptyIsAbsent})}`,
      `  aria-invalid={fieldState.invalid}`,
      `/>`,
    ]
  }
  return [
    `        <Controller`,
    `          name="${f.name}"`,
    `          control={form.control}`,
    `          render={({ field, fieldState }) => (`,
    `            <Field data-invalid={fieldState.invalid}>`,
    `              <FieldLabel htmlFor="${id}">${label}</FieldLabel>`,
    ...input.map((line) => `              ${line}`),
    `              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}`,
    `            </Field>`,
    `          )}`,
    `        />`,
  ]
}

/** A create form for the resource, inserted where it lands, or why there can't be one. */
export function formTemplate(resource: ManifestResource, ctx: CodegenContext): Template | string {
  const generated = formFile(resource, ctx)
  if (typeof generated === 'string') return generated
  return {
    component: generated.component,
    label: `${resource.name} create form`,
    snippet: `<${generated.component} />`,
    imports: [{ name: generated.component, source: generated.importPath }],
    before: [{ op: 'createFile', file: generated.file, content: generated.content, ifMissing: true }],
  }
}
