// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'

import { find, mount, press } from '@/shared/lib/test-utils'

import { ExpressionInput } from './ExpressionInput'

it('FR-DS-03 underlines the server UTF-16 span and exposes the message to assistive technology', async () => {
  const expression = '"🐱" + ui.missing.value'
  const ui = await mount(<ExpressionInput label="children expression" pointer="/bindings/node/children" value={expression} onSave={vi.fn()} diagnostics={[{
    code: 'expr_unknown_ui', doc: 'pages/Editor.page.json', severity: 'error', pointer: '/bindings/node/children',
    span: { start: 7, end: 17, unit: 'utf16' }, message: 'Unknown name missing',
  }]} />)
  try {
    const input = find<HTMLTextAreaElement>(ui.host, 'textarea')
    expect(input.value).toBe(expression)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const message = find(ui.host, '[role="alert"]')
    expect(input.getAttribute('aria-describedby')).toContain(message.id)
    expect(message.textContent).toContain('Unknown name missing')
    expect(find(ui.host, 'code u').textContent).toBe('ui.missing')
  } finally {
    await ui.unmount()
  }
})

it('FR-DS-03 can save a proposed binding using the keyboard', async () => {
  const save = vi.fn()
  const ui = await mount(<ExpressionInput label="value expression" pointer="/bindings/node/value" value='"hello"' proposed onSave={save} />)
  try {
    await press(find(ui.host, 'textarea'), { key: 'Enter', ctrlKey: true })
    expect(save).toHaveBeenCalledWith('"hello"')
  } finally {
    await ui.unmount()
  }
})
