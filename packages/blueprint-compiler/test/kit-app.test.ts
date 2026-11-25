import { existsSync, readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

const app = new URL('../../../examples/blueprint-kit/', import.meta.url)

it('installs the component kit and Refine views in the Radix template (FR-KT-01)', () => {
  const config = JSON.parse(readFileSync(new URL('components.json', app), 'utf8'))
  expect(config.style).toBe('radix-nova')
  const items = [
    'button', 'dropdown-menu', 'badge', 'avatar', 'alert', 'tooltip', 'skeleton', 'breadcrumb',
    'empty', 'input', 'textarea', 'select', 'checkbox', 'switch', 'radio-group', 'command',
    'calendar', 'label', 'field', 'card', 'tabs', 'dialog', 'sheet', 'popover', 'separator',
  ]
  for (const item of items) expect(existsSync(new URL(`src/components/ui/${item}.tsx`, app)), item).toBe(true)
  expect(existsSync(new URL('src/components/refine-ui/data-table/data-table.tsx', app))).toBe(true)
  expect(existsSync(new URL('src/components/refine-ui/layout/layout.tsx', app))).toBe(true)
})

it('provides the banking contract for both composites (FR-KT-02, FR-KT-03)', () => {
  const manifest = JSON.parse(readFileSync(new URL('trivia.manifest.json', app), 'utf8'))
  expect(manifest.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Customer', operations: expect.objectContaining({ list: expect.any(Object), create: expect.any(Object) }) }),
    expect.objectContaining({ name: 'Account' }),
    expect.objectContaining({ name: 'Transaction' }),
  ]))
})
