// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { canvas } from '@/shared/canvas'
import { engine } from '@/shared/engine/client'
import type { BlueprintSummary } from '@/shared/engine/types'
import { find, mount } from '@/shared/lib/test-utils'

import { BlueprintTab } from './BlueprintTab'

const customers: BlueprintSummary = {
  exists: true, dir: 'blueprint', app: null, model: null, diagnostics: [], next: '',
  pages: [{
    name: 'Customers', path: 'pages/Customers.page.json', route: '/customers', kind: 'list',
    rev: 'original', status: 'draft', warnings: 0, errors: 0,
  }],
}

afterEach(() => vi.restoreAllMocks())

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
