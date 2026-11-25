// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'

import type { ContractKind, ManifestField, ManifestOperation, ManifestResource } from '@/shared/engine/types'
import { find, mount } from '@/shared/lib/test-utils'

import { PageForm } from './PageForm'

const field = (name: string): ManifestField => ({
  name, type: 'string', format: null, required: false, nullable: false, readOnly: false, enum: null, description: null,
})
const operation = (kind: ManifestOperation['kind'], fields?: ManifestField[]): ManifestOperation => ({
  kind, method: 'GET', path: '/customers', summary: null, sdkFn: kind, queryOptionsFn: null, queryKeyFn: null, mutationFn: null,
  requestBody: fields ? { required: true, contentType: null, zodSchema: null, fields } : null,
})
const customer: ManifestResource = {
  name: 'customers', primaryKey: 'id', entity: { fields: [field('displayName')] },
  operations: {
    list: operation('list'), get: operation('get'), create: operation('create', [field('createName')]),
    update: operation('update', [field('updateName')]), delete: null,
  },
  customOperations: [],
}

it.each([
  ['list', 'displayName'],
  ['show', 'displayName'],
  ['create', 'createName'],
  ['edit', 'updateName'],
] as [ContractKind, string][])('FR-DS-02 edits %s options from the correct operation fields', async (kind, name) => {
  const save = vi.fn().mockResolvedValue(true)
  const ui = await mount(<PageForm resources={[customer]} save={save} document={{
    path: 'pages/Customers.page.json', rev: 'read',
    doc: {
      $schema: 'page-v1', blueprintVersion: 1, id: 'page', name: 'Customers', public: false,
      route: '/customers', kind, resource: customer.name, options: { title: 'My customers' },
    },
  }} />)
  try {
    expect(ui.host.textContent).toContain(name)
    expect(ui.host.textContent?.includes('Filters')).toBe(kind === 'list')
    await act(async () => find<HTMLInputElement>(ui.host, 'input[aria-label="Use template fields"]').click())
    expect(save).toHaveBeenCalledExactlyOnceWith({
      op: 'setPageMeta', doc: 'pages/Customers.page.json', baseRev: 'read', options: { title: 'My customers', fields: [] },
    }, 'Blueprint: set fields of Customers')
  } finally {
    await ui.unmount()
  }
})

it('FR-DS-02 disables contract kinds without a synced contract', async () => {
  const ui = await mount(<PageForm resources={[]} save={vi.fn()} />)
  try {
    const kinds = find<HTMLSelectElement>(ui.host, 'select[name="kind"]')
    expect(kinds.value).toBe('custom')
    expect([...kinds.options].filter((option) => option.disabled).map((option) => option.value)).toEqual(['list', 'create', 'edit', 'show'])
    expect(ui.host.textContent).toContain('Data tab')
  } finally {
    await ui.unmount()
  }
})
