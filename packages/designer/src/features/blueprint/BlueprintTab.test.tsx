// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { canvas } from '@/shared/canvas'
import { engine } from '@/shared/engine/client'
import type { BlueprintSummary } from '@/shared/engine/types'
import { designer } from '@/shared/state/store'
import { find, mount } from '@/shared/lib/test-utils'

import { BlueprintTab } from './BlueprintTab'

const customers: BlueprintSummary = {
  exists: true, dir: 'blueprint', app: null, model: null, diagnostics: [], next: '',
  pages: [{
    name: 'Customers', path: 'pages/Customers.page.json', route: '/customers', kind: 'list',
    rev: 'original', status: 'draft', warnings: 0, errors: 0,
  }],
}

afterEach(() => {
  vi.restoreAllMocks()
  designer.setState(designer.getInitialState(), true)
})

it('FR-DS-04 navigates to the compiled preview returned by the host', async () => {
  vi.spyOn(engine.blueprint, 'summary').mockResolvedValue(customers)
  vi.spyOn(engine, 'manifest').mockResolvedValue({ manifest: null, drift: null })
  const preview = vi.spyOn(engine.blueprint, 'preview').mockResolvedValue({
    page: 'Customers', route: '/__blueprint/Customers', module: '/preview.tsx',
    code: '', requires: [], diagnostics: [],
  })
  const navigate = vi.spyOn(canvas, 'navigate').mockImplementation(() => {})
  const ui = await mount(<BlueprintTab />)
  try {
    await act(async () => find<HTMLButtonElement>(ui.host, 'button[aria-label="Preview Customers"]').click())
    expect(preview).toHaveBeenCalledExactlyOnceWith('Customers')
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/__blueprint/Customers')
  } finally {
    await ui.unmount()
  }
})

it('FR-DS-01 opens the real route and only offers re-eject while source matches the lock', async () => {
  const ejected = { ...customers.pages[0]!, status: 'ejected' as const, file: 'src/pages/Customers.tsx' }
  const edited = {
    ...ejected, name: 'Accounts', path: 'pages/Accounts.page.json', status: 'edited' as const,
    file: 'src/pages/Accounts.tsx', route: '/account-draft',
  }
  vi.spyOn(engine.blueprint, 'summary').mockResolvedValue({ ...customers, pages: [ejected, edited] })
  vi.spyOn(engine, 'manifest').mockResolvedValue({ manifest: null, drift: null })
  vi.spyOn(engine, 'routes').mockResolvedValue([{
    path: '/accounts/:id', file: edited.file, component: 'Accounts', params: ['id'], index: false, catchAll: false, resource: null,
    router: 'react-router', declared: { file: 'src/App.tsx', line: 1 }, locator: null,
  }])
  const navigate = vi.spyOn(canvas, 'navigate').mockImplementation(() => {})
  const ui = await mount(<BlueprintTab />)
  try {
    expect(find(ui.host, 'button[aria-label="Eject Customers again"]')).toBeDefined()
    expect(ui.host.querySelector('button[aria-label="Eject Accounts again"]')).toBeNull()
    expect(ui.host.querySelector('button[aria-label="Edit Accounts"]')).toBeNull()
    expect(ui.host.textContent).toContain('the code is now the truth')
    await act(async () => find<HTMLButtonElement>(ui.host, 'button[aria-label="Open Accounts"]').click())
    const form = find<HTMLFormElement>(document.body, '[role="dialog"] form')
    find<HTMLInputElement>(form, 'input[name="param-id"]').value = 'A B'
    await act(async () => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })))
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/accounts/A%20B')
  } finally {
    await ui.unmount()
  }
})

it('FR-DS-07 reloads the open document after focus and after history changes', async () => {
  const current = customers.pages[0]!
  let rev = 'initial'
  let route = '/customers'
  vi.spyOn(engine.blueprint, 'summary').mockImplementation(async () => ({ ...customers, pages: [{ ...current, rev, route }] }))
  vi.spyOn(engine, 'manifest').mockResolvedValue({ manifest: null, drift: null })
  vi.spyOn(engine.blueprint, 'doc').mockImplementation(async (path) => ({
    path, rev, doc: {
      $schema: 'page', blueprintVersion: 1, id: 'page', kind: 'list', name: 'Customers',
      route, resource: 'Customer', options: {}, public: false,
    },
  }))
  const ui = await mount(<BlueprintTab />)
  try {
    await act(async () => find<HTMLButtonElement>(ui.host, 'button[aria-label="Edit Customers"]').click())
    const routeInput = () => find<HTMLInputElement>(ui.host, 'input[data-pointer="/route"]')
    expect(routeInput().value).toBe('/customers')
    rev = 'newer'
    route = '/agent-route'
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(routeInput().value).toBe('/agent-route')
    rev = 'initial'
    route = '/customers'
    await act(async () => designer.getState().setHistory({ canUndo: false, canRedo: true, undoLabel: null, redoLabel: 'Agent route' }))
    expect(routeInput().value).toBe('/customers')
  } finally {
    await ui.unmount()
  }
})
