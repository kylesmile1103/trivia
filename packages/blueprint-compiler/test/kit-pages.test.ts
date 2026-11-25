import { fileURLToPath } from 'node:url'

import { loadBlueprint } from '@trivia/blueprint'
import { expect, it } from 'vitest'

import { checkDataTable, compilePage } from '../src/index.js'
import { compileKitPage, fixture, fixtureDir, kitFormFieldContext, kitManifests, kitServiceContext } from './kit-fixture.js'

it('FR-KT-01 compiles the action and display kit with the installed slot parts', async () => {
  expect(kitManifests().map(({ type }) => type)).toEqual(expect.arrayContaining([
    'Button', 'DropdownMenu', 'Badge', 'Avatar', 'Alert', 'Tooltip', 'Skeleton', 'Breadcrumb', 'Empty',
  ]))
  const { code, requires } = compileKitPage('KitDisplay')
  expect(requires).toEqual([])
  expect(code).toContain('<AlertTitle>')
  expect(code).toContain('<DropdownMenuTrigger>')
  expect(code).toContain('<BreadcrumbList>')
  expect(code).toContain('handleRefreshOnClick')
  await expect(code).toMatchFileSnapshot(fileURLToPath(new URL('golden/KitDisplay.tsx', fixtureDir)))
})

it('FR-KT-01 compiles all input values and keeps their controls connected to bindings', async () => {
  expect(kitManifests().map(({ type }) => type)).toEqual(expect.arrayContaining([
    'Input', 'Textarea', 'Select', 'Checkbox', 'Switch', 'RadioGroup', 'Combobox', 'DatePicker', 'Label', 'Field',
  ]))
  const { code, requires } = compileKitPage('KitInputs')
  expect(requires).toEqual([])
  for (const state of ['searchValue', 'notesValue', 'segmentValue', 'confirmedChecked', 'alertsChecked', 'channelValue', 'customerValue', 'birthdayValue']) {
    expect(code).toContain(state)
  }
  expect(code).toContain('<SelectValue')
  expect(code).toContain('<CommandItem')
  expect(code).toContain('mode="single"')
  expect(code).toContain('setConfirmedChecked(_event === true)')
  await expect(code).toMatchFileSnapshot(fileURLToPath(new URL('golden/KitInputs.tsx', fixtureDir)))
})

it('FR-KT-01 emits container slots and connects open and tab value bindings', async () => {
  expect(kitManifests().map(({ type }) => type)).toEqual(expect.arrayContaining([
    'Card', 'Tabs', 'Dialog', 'Sheet', 'Popover', 'Separator',
  ]))
  const { code, requires } = compileKitPage('KitContainers')
  expect(requires).toEqual([])
  for (const part of ['CardHeader', 'CardContent', 'CardFooter', 'DialogTrigger', 'DialogContent', 'SheetTrigger', 'SheetContent', 'PopoverTrigger', 'PopoverContent']) {
    expect(code).toContain('<' + part + '>')
  }
  expect(code).toContain('<TabsTrigger value="summary">Summary</TabsTrigger>')
  expect(code).toContain('<TabsContent value="summary">')
  expect(code).toContain('useState<string>("summary")')
  expect(code).toContain('open={helpOpen}')
  await expect(code).toMatchFileSnapshot(fileURLToPath(new URL('golden/KitContainers.tsx', fixtureDir)))
})

it('FR-KT-02 and FR-KT-04 compile a server-side Refine table with editable columns', async () => {
  const { code, requires } = compileKitPage('KitTable', await kitServiceContext())
  expect(requires).toEqual([])
  expect(code).toContain('useTable<CustomerDto>')
  expect(code).toContain('pagination: { mode: "server", pageSize: 3 }')
  expect(code).toContain('sorters: { mode: "server" }')
  expect(code).toContain('filters: { mode: "server" }')
  expect(code).toContain('<DataTable table={table} />')
  await expect(code).toMatchFileSnapshot(fileURLToPath(new URL('golden/KitTable.tsx', fixtureDir)))
})


it('FR-KT-02 reports a resource without a list operation at the table resource prop', async () => {
  const { contract } = await kitServiceContext()
  const entry = loadBlueprint(fixture()).docs['pages/KitTable.page.json']
  if (!contract || entry?.kind !== 'page' || entry.doc?.kind !== 'custom') throw new Error('Missing table fixture')
  const page = entry.doc
  const [id] = Object.entries(page.nodes).find(([, node]) => node.type === 'DataTable')!
  contract.resources.find(({ name }) => name === 'Customer')!.operations.list = null
  expect(checkDataTable(page, id, contract).diagnostics).toEqual([expect.objectContaining({
    code: 'unsupported_operation', pointer: `/props/${id}/resource`,
  })])
})

it('FR-KT-02 exposes the selected row and typed multiple selection to bindings', async () => {
  const context = await kitServiceContext()
  const { code } = compileKitPage('KitTable', context)
  expect(code).toContain('const customersSelectedRow: Partial<CustomerDto>')
  expect(code).toContain('customersSelectedRow.id')
  expect(code).toContain('type="radio"')
  expect(code).toContain('getRowId: (row) => String(row["id"])')

  const files = fixture()
  const file = 'pages/KitTable.page.json'
  const page = JSON.parse(files[file]!)
  const id = Object.keys(page.props).find((key) => page.props[key].resource === 'Customer')!
  const binding = Object.keys(page.bindings)[0]!
  page.props[id].selectable = 'multiple'
  page.bindings[binding].children = 'ui.customers.selectedRows.length'
  const multiple = compilePage(loadBlueprint({ ...files, [file]: JSON.stringify(page) }), 'KitTable', context)
  expect(multiple.code).toContain('type="checkbox"')
  expect(multiple.code).toContain('customersSelectedRows.length')

  delete page.props[id].selectable
  expect(() => compilePage(loadBlueprint({ ...files, [file]: JSON.stringify(page) }), 'KitTable', context))
    .toThrow('Cannot compile blueprint page KitTable')
})

it('FR-KT-03 compiles forms with matching inputs, defaults and rules in both project styles', async () => {
  const current = await kitServiceContext()
  const legacy = await kitFormFieldContext()
  expect(current.facts.formStyle).toBe('Field')
  expect(legacy.facts.formStyle).toBe('FormField')
  for (const [directory, context, control] of [
    ['golden', current, 'Controller'],
    ['golden/form-field', legacy, 'FormField'],
  ] as const) {
    const { code, requires } = compileKitPage('KitForm', context)
    expect(requires).toEqual([])
    expect(code).toContain('resolver: zodResolver(')
    expect(code).toContain('redirect: "list"')
    expect(code).toContain('sm:grid-cols-2')
    expect(code).toContain('<' + control)
    for (const field of ['fullName', 'email', 'segment', 'notes']) expect(code).toContain(`name="${field}"`)
    expect(code).toContain('Fields marked required must be completed.')
    await expect(code).toMatchFileSnapshot(fileURLToPath(new URL(directory + '/KitForm.tsx', fixtureDir)))
  }

  const files = fixture()
  const file = 'pages/KitForm.page.json'
  const page = JSON.parse(files[file]!)
  const props = Object.values(page.props).find((entry: unknown) => (entry as { resource?: string }).resource === 'Customer') as { fields: string[] }
  props.fields.push('birthDate')
  const date = compilePage(loadBlueprint({ ...files, [file]: JSON.stringify(page) }), 'KitForm', current)
  expect(date.code).toContain('<Calendar')
  expect(date.code).toContain('mode="single"')
  expect(date.code).toContain('birthDate: z.iso.date(')
})
