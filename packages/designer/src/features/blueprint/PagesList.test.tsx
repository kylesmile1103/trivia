// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'

import type { BlueprintSummary } from '@/shared/engine/types'
import { find, mount } from '@/shared/lib/test-utils'

import { PagesList } from './PagesList'

const summary: BlueprintSummary = {
  exists: true, dir: 'blueprint', app: null, model: null, diagnostics: [], next: '',
  pages: [{
    name: 'Customers', path: 'pages/Customers.page.json', rev: 'rev', route: '/customers',
    kind: 'list', status: 'draft', warnings: 1, errors: 2,
  }],
}

it('FR-DS-01 lists the kind, route, diagnostics and status for a page', async () => {
  const open = vi.fn()
  const ui = await mount(<PagesList summary={summary} openPath={null} onOpen={open} onAdd={vi.fn()} onInitialize={vi.fn()} />)
  try {
    expect(ui.host.textContent).toContain('/customers')
    expect(ui.host.textContent).toContain('list')
    expect(ui.host.textContent).toContain('draft')
    expect(ui.host.textContent).toContain('2 errors')
    expect(ui.host.textContent).toContain('1 warning')
    await act(async () => find<HTMLButtonElement>(ui.host, 'button[aria-label="Edit Customers"]').click())
    expect(open).toHaveBeenCalledWith('pages/Customers.page.json')
  } finally {
    await ui.unmount()
  }
})

it('FR-DS-02 offers initialization and then offers adding a first page', async () => {
  const initialize = vi.fn()
  const add = vi.fn()
  const props = { openPath: null, onOpen: vi.fn(), onAdd: add, onInitialize: initialize }
  const ui = await mount(<PagesList {...props} summary={{ ...summary, exists: false, pages: [] }} />)
  try {
    await act(async () => find<HTMLButtonElement>(ui.host, 'button').click())
    expect(initialize).toHaveBeenCalledTimes(1)
    await ui.render(<PagesList {...props} summary={{ ...summary, pages: [] }} />)
    expect(ui.host.textContent).toContain('No pages')
    await act(async () => find<HTMLButtonElement>(ui.host, 'button').click())
    expect(add).toHaveBeenCalledTimes(1)
  } finally {
    await ui.unmount()
  }
})
