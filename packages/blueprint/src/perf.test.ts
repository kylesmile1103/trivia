import { performance } from 'node:perf_hooks'

import { expect, it } from 'vitest'

import { newId, sequenceSource } from './ids.js'
import { keysBetween } from './order.js'
import { loadBlueprint } from './store.js'
import type { AppDoc } from './types/app.js'
import { BLUEPRINT_VERSION, SCHEMA_URL } from './types/common.js'
import { APP_DOC, pageDocPath } from './types/ops.js'
import type { CustomPage } from './types/page.js'
import { validateStructure } from './validate/index.js'

const PAGE_COUNT = 200

function blueprintFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  const ids = sequenceSource()
  const siblingOrders = keysBetween(null, null, 5)
  const app: AppDoc = {
    $schema: SCHEMA_URL.app,
    blueprintVersion: BLUEPRINT_VERSION,
    name: 'PerformanceApp',
    targets: { web: 'vite-refine' },
    auth: { mode: 'none' },
    theme: { tokens: {} },
    nav: [],
  }

  for (let index = 1; index <= PAGE_COUNT; index++) {
    const name = `CustomerPage${index}`
    const root = newId('n', ids)
    const page: CustomPage = {
      $schema: SCHEMA_URL.page,
      blueprintVersion: BLUEPRINT_VERSION,
      id: newId('pg', ids),
      name,
      route: `/customers/page-${index}`,
      kind: 'custom',
      resource: 'Customer',
      public: false,
      root,
      nodes: { [root]: { type: 'div', name: 'page', parent: null, slot: null, order: 'a0' } },
      props: {},
      bindings: {},
      styles: { [root]: { className: 'grid gap-4 p-6' } },
      control: {},
      state: { selectedIndex: { type: 'number | null', initial: null } },
      queries: { customers: { kind: 'list', resource: 'Customer', params: { pageSize: '25' } } },
      actions: {},
    }

    for (const [group, groupOrder] of siblingOrders.entries()) {
      const parent = newId('n', ids)
      page.nodes[parent] = { type: 'section', name: `group${group}`, parent: root, slot: 'children', order: groupOrder }
      for (const [position, order] of siblingOrders.entries()) {
        const id = newId('n', ids)
        const customerIndex = group * siblingOrders.length + position
        page.nodes[id] = { type: 'Button', name: `selectCustomer${customerIndex}`, parent, slot: 'children', order }
        page.props[id] = { children: `Select customer ${customerIndex + 1}`, variant: 'outline' }
        page.bindings[id] = { disabled: `state.selectedIndex === ${customerIndex}` }
        page.styles[id] = { className: 'w-full' }
        page.control[id] = { when: `data.customers.total > ${customerIndex}` }
        page.actions[`${id}.onClick`] = [
          { do: 'setState', name: 'selectedIndex', value: String(customerIndex) },
          { do: 'refetch', query: 'customers' },
        ]
      }
    }

    app.nav.push({ page: name, label: `Customers ${index}`, icon: 'users' })
    files[pageDocPath(name)] = JSON.stringify(page, null, 2) + '\n'
  }

  files[APP_DOC] = JSON.stringify(app, null, 2) + '\n'
  return files
}

it('loads and structurally validates 200 pages in under one second', () => {
  const files = blueprintFiles()
  validateStructure(loadBlueprint(files))

  const start = performance.now()
  const diagnostics = validateStructure(loadBlueprint(files))
  const duration = performance.now() - start

  console.log(`Loaded and structurally validated ${PAGE_COUNT} pages in ${duration.toFixed(2)} ms`)
  expect(diagnostics).toEqual([])
  expect(duration).toBeLessThan(1000)
})
