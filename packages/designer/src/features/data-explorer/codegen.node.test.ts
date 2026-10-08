// The Data panel's generated code: what it contains, when it refuses, and (the part that
// matters) that it type-checks inside the real playground, against the real hey-api output,
// zod schemas, react-hook-form and shadcn components.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ComponentSchema, TriviaManifest } from '@/shared/engine/types'

import { type CodegenContext, dataTableFile, formFile, formTemplate, humanize, importOf, kebab, tableTemplate } from './codegen'

const PLAYGROUND = path.resolve(import.meta.dirname, '../../../../../examples/playground')
const manifest = JSON.parse(fs.readFileSync(path.join(PLAYGROUND, 'trivia.manifest.json'), 'utf8')) as TriviaManifest
const customer = manifest.resources.find((r) => r.name === 'Customer')!

const component = (name: string, file: string): ComponentSchema =>
  ({ name, file: `src/components/ui/${file}.tsx`, importSource: `@/components/ui/${file}`, baseElement: null, acceptsChildren: true, props: [] }) as ComponentSchema
const LIBRARY = Object.fromEntries(
  [
    ['Table', 'table'],
    ['Field', 'field'],
    ['Input', 'input'],
    ['Button', 'button'],
    ['Select', 'select'],
    ['Checkbox', 'checkbox'],
  ].map(([name, file]) => [name, component(name!, file!)]),
)
const ctx: CodegenContext = { manifest, components: LIBRARY, componentsDir: 'src/components', componentsImport: '@/components' }

describe('naming', () => {
  it('humanizes field names and kebab-cases resource names', () => {
    expect(['fullName', 'kycStatus', 'created_at', 'id'].map(humanize)).toEqual(['Full name', 'Kyc status', 'Created at', 'Id'])
    expect(['Customer', 'OrderLine'].map(kebab)).toEqual(['customer', 'order-line'])
  })

  it('imports a generated module by its alias, else relatively', () => {
    expect(importOf({ file: 'src/api/generated/zod.gen.ts', importPath: '@/api/generated/zod.gen' }, 'src/components/forms/x.tsx')).toBe('@/api/generated/zod.gen')
    expect(importOf({ file: 'src/api/generated/zod.gen.ts', importPath: null }, 'src/components/forms/x.tsx')).toBe('../../api/generated/zod.gen')
    expect(importOf({ file: 'src/api/zod.gen.ts', importPath: null }, 'src/x.tsx')).toBe('./api/zod.gen')
  })
})

describe('templates', () => {
  it('a table: the component file if missing, the element, and its binding to the list query', () => {
    const t = tableTemplate(customer, ctx)
    if (typeof t === 'string') throw new Error(t)
    expect(t.snippet).toBe(
      '<DataTable\n  columns={[\n    { key: "fullName", header: "Full name" },\n    { key: "email", header: "Email" },\n    { key: "phone", header: "Phone" },\n    { key: "status", header: "Status" },\n    { key: "kycStatus", header: "Kyc status" },\n  ]}\n/>',
    )
    expect(t.before).toEqual([{ op: 'createFile', file: 'src/components/data-table.tsx', content: dataTableFile(ctx).content, ifMissing: true }])
    expect(t.bind).toEqual({
      optionsFn: 'listCustomersOptions',
      optionsImport: '@/api/generated/@tanstack/react-query.gen',
      resource: 'Customer',
      itemsPath: 'items',
      dataProp: 'data',
      loadingProp: 'isLoading',
    })
  })

  it('a create form, from the create body and its zod schema', () => {
    const t = formTemplate(customer, ctx)
    if (typeof t === 'string') throw new Error(t)
    expect(t.snippet).toBe('<CustomerCreateForm />')
    expect(t.imports).toEqual([{ name: 'CustomerCreateForm', source: '@/components/forms/customer-create-form' }])
    const file = formFile(customer, ctx)
    if (typeof file === 'string') throw new Error(file)
    expect(file.content).toContain('resolver: zodResolver(zCreateCustomerBody)')
    expect(file.content).toContain('<form noValidate onSubmit=')
    expect(file.content).toContain('<FieldLabel htmlFor="customer-email">Email *</FieldLabel>') // required: an asterisk
    expect(file.content).toContain('<FieldLabel htmlFor="customer-phone">Phone</FieldLabel>')
    expect(file.content).toContain('type="date"')
    expect(file.content).toContain('{/* address (object): not generated; add its fields by hand */}')
    expect(file.content).toContain('queryClient.invalidateQueries({ queryKey: listCustomersQueryKey() })')
  })

  it('says why not, instead of generating something broken', () => {
    const health = manifest.resources.find((r) => r.name === 'Health')!
    expect(tableTemplate(health, ctx)).toBe('it has no list operation')
    expect(formTemplate(health, ctx)).toBe('it has no create operation')
    const noZod = { ...ctx, manifest: { ...manifest, modules: { ...manifest.modules, zod: null } } }
    expect(formTemplate(customer, noZod)).toBe('the contract was generated without zod (run contract-sync with --zod)')
    const { Field: _, ...withoutField } = LIBRARY
    expect(formTemplate(customer, { ...ctx, components: withoutField })).toBe('it needs shadcn field (npx shadcn add field)')
  })
})

describe('in the playground', () => {
  let dir: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-codegen-'))
    for (const entry of ['src', 'package.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts', 'mock-api.ts']) {
      fs.cpSync(path.join(PLAYGROUND, entry), path.join(dir, entry), { recursive: true })
    }
    fs.symlinkSync(path.join(PLAYGROUND, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('type-checks: the DataTable, a page bound the way bindQuery writes it, and the create form', () => {
    const table = dataTableFile(ctx)
    const form = formFile(customer, ctx)
    if (typeof form === 'string') throw new Error(form)
    const t = tableTemplate(customer, ctx)
    if (typeof t === 'string') throw new Error(t)
    for (const f of [table, form]) {
      fs.mkdirSync(path.join(dir, path.dirname(f.file)), { recursive: true })
      fs.writeFileSync(path.join(dir, f.file), f.content)
    }
    const element = t.snippet.replace('/>', '  data={customerData?.items ?? []}\n  isLoading={isCustomerLoading}\n/>')
    fs.writeFileSync(
      path.join(dir, 'src/pages/Customers.tsx'),
      [
        `import { useQuery } from "@tanstack/react-query"`,
        `import { listCustomersOptions } from "@/api/generated/@tanstack/react-query.gen"`,
        `import { DataTable } from "${table.importPath}"`,
        `import { CustomerCreateForm } from "${form.importPath}"`,
        ``,
        `export function Customers() {`,
        `  const { data: customerData, isLoading: isCustomerLoading } = useQuery({ ...listCustomersOptions() })`,
        `  return (`,
        `    <div>`,
        `      <CustomerCreateForm />`,
        ...element.split('\n').map((line) => `      ${line}`),
        `    </div>`,
        `  )`,
        `}`,
        ``,
      ].join('\n'),
    )
    const tsc = spawnSync(path.join(dir, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.app.json', '--noEmit'], { cwd: dir, encoding: 'utf8' })
    expect(tsc.stdout + tsc.stderr).toBe('')
    expect(tsc.status).toBe(0)
  }, 120_000)

  it('the check is not vacuous: a column that is no field of the rows fails', () => {
    const page = path.join(dir, 'src/pages/Wrong.tsx')
    fs.writeFileSync(
      page,
      `import { DataTable } from "@/components/data-table"\nimport type { CustomerDto } from "@/api/generated/types.gen"\nexport const Wrong = ({ rows }: { rows: CustomerDto[] }) => <DataTable columns={[{ key: "nope", header: "Nope" }]} data={rows} />\n`,
    )
    const tsc = spawnSync(path.join(dir, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.app.json', '--noEmit'], { cwd: dir, encoding: 'utf8' })
    fs.rmSync(page)
    expect(tsc.status).not.toBe(0)
    expect(tsc.stdout).toContain('nope')
  }, 120_000)
})
