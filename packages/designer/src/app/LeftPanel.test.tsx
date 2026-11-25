// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { engine } from '@/shared/engine/client'
import { mount } from '@/shared/lib/test-utils'
import { designer } from '@/shared/state/store'

import { LeftPanel } from './LeftPanel'

afterEach(() => {
  designer.setState(designer.getInitialState(), true)
  vi.restoreAllMocks()
})

it('FR-DS-01 opens the Blueprint feature from a named icon tab', async () => {
  const summary = vi.spyOn(engine.blueprint, 'summary').mockResolvedValue({
    dir: 'blueprint', exists: false, app: null, model: null, pages: [], diagnostics: [], next: '',
  })
  const ui = await mount(<LeftPanel />)
  try {
    const tabs = [...ui.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Layers', 'Pages', 'Components', 'Data', 'Blueprint'])
    expect(tabs.every((tab) => tab.querySelector('svg[aria-hidden="true"]'))).toBe(true)
    await act(async () => tabs[4]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    expect(tabs[4]?.getAttribute('aria-selected')).toBe('true')
    expect(summary).toHaveBeenCalledTimes(1)
  } finally {
    await ui.unmount()
  }
})
