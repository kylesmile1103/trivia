// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { canvas } from '@/shared/canvas'
import { ApiError, engine } from '@/shared/engine/client'
import type { BlueprintEjectPlan, BlueprintPageSummary } from '@/shared/engine/types'
import { find, mount } from '@/shared/lib/test-utils'
import { designer } from '@/shared/state/store'

import { EjectDialog } from './EjectDialog'

const page: BlueprintPageSummary = {
  name: 'Customers', path: 'pages/Customers.page.json', kind: 'list', route: '/customers',
  rev: 'read', status: 'draft', errors: 0, warnings: 0,
}
const file = 'src/pages/Customers.tsx'
const plan: BlueprintEjectPlan = {
  files: [file], requires: [], warnings: [], label: 'Eject Customers',
  lock: { lockVersion: 1, pages: { Customers: { file, hash: 'generated', route: '/customers' } } },
  ops: [
    { op: 'createFile', file, content: 'export function Customers() { return null }' },
    { op: 'setProperty', path: 'src/App.tsx#App#<Refine>.resources[name=customers]', prop: 'list', value: '"/customers"' },
    { op: 'createFile', file: 'blueprint/blueprint.lock.json', content: '{}' },
  ],
}

afterEach(() => {
  vi.restoreAllMocks()
  designer.setState(designer.getInitialState(), true)
})

it('FR-DS-04 lists the plan and applies it in the action bus before acknowledging and navigating', async () => {
  const getPlan = vi.spyOn(engine.blueprint, 'plan').mockResolvedValue(plan)
  const batch = vi.spyOn(engine, 'batch').mockResolvedValue({
    file, changed: true, locator: null, history: { canUndo: true, canRedo: false, undoLabel: plan.label, redoLabel: null },
  })
  const acknowledge = vi.spyOn(engine.blueprint, 'ejected').mockResolvedValue({ lockRev: 'locked' })
  const navigate = vi.spyOn(canvas, 'navigate').mockImplementation(() => {})
  const close = vi.fn()
  const ui = await mount(<EjectDialog page={page} onClose={close} onRefresh={vi.fn()} />)
  try {
    const dialog = find(document.body, '[role="dialog"]')
    expect(dialog.textContent).toContain(file)
    expect(dialog.textContent).toContain('src/App.tsx')
    expect(dialog.textContent).toContain('blueprint/blueprint.lock.json')
    expect(dialog.textContent).toContain('/customers')
    expect(dialog.textContent).toContain('customers')
    expect(batch).not.toHaveBeenCalled()
    expect(getPlan).toHaveBeenCalledExactlyOnceWith(['Customers'])
    await act(async () => find<HTMLButtonElement>(dialog, 'button[data-confirm]').click())
    expect(batch).toHaveBeenCalledExactlyOnceWith(plan.ops, plan.label)
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(['Customers'], plan.label)
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/customers')
    expect(batch.mock.invocationCallOrder[0]).toBeLessThan(acknowledge.mock.invocationCallOrder[0]!)
    expect(acknowledge.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]!)
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    await ui.unmount()
  }
})

it('FR-DS-04 shows a copyable command for missing registry items with no confirmation', async () => {
  vi.spyOn(engine.blueprint, 'plan').mockRejectedValue(new ApiError({
    code: 'unresolved_component', message: 'Install components',
    details: { requires: [{ registry: 'shadcn', item: 'card' }, { registry: 'refine', item: 'views' }] },
  }, 422))
  const ui = await mount(<EjectDialog page={page} onClose={vi.fn()} onRefresh={vi.fn()} />)
  try {
    const dialog = find(document.body, '[role="dialog"]')
    expect(find<HTMLInputElement>(dialog, 'input[readonly]').value).toBe('pnpm dlx shadcn add -- card https://ui.refine.dev/r/views.json')
    expect(dialog.querySelector('button[data-confirm]')).toBeNull()
  } finally {
    await ui.unmount()
  }
})
