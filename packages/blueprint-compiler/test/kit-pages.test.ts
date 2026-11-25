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
