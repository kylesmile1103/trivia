// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'

import { find, mount } from '@/shared/lib/test-utils'

import { Diagnostics, focusDiagnosticField } from './Diagnostics'

it('FR-DS-01 focuses the closest editor for a nested diagnostic pointer', async () => {
  const diagnostic = {
    severity: 'error', code: 'expr_parse', message: 'Expected an expression', doc: 'pages/Customers.page.json',
    pointer: '/options/headerActions/0/steps/0/to',
  } as const
  const ui = await mount(
    <div>
      <input aria-label="Name" data-pointer="/name" />
      <textarea aria-label="Header actions" data-pointer="/options/headerActions" />
      <Diagnostics diagnostics={[diagnostic]} onActivate={(item) => focusDiagnosticField(ui.host, item.pointer)} />
    </div>,
  )
  try {
    const button = find<HTMLButtonElement>(ui.host, 'button')
    expect(button.textContent).toContain('Expected an expression')
    await act(async () => button.click())
    expect(document.activeElement).toBe(find(ui.host, 'textarea'))
  } finally {
    await ui.unmount()
  }
})
