import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { compileKitPage, fixtureDir, kitManifests } from './kit-fixture.js'

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
