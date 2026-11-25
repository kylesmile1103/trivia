// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'

import type { BlueprintComponents, BlueprintDocument, CustomPage } from '@/shared/engine/types'
import { find, mount } from '@/shared/lib/test-utils'

import { NodeProps } from './NodeProps'

const document: BlueprintDocument<CustomPage> = {
  path: 'pages/Editor.page.json', rev: 'saved', doc: {
    $schema: 'page', blueprintVersion: 1, id: 'page', kind: 'custom', name: 'Editor', route: '/editor', public: false, root: 'input',
    nodes: { input: { type: 'Input', name: 'search', parent: null, slot: null, order: 'a0' } },
    props: { input: { placeholder: 'Search' } }, bindings: {}, styles: {}, control: {}, state: {}, queries: {}, actions: {},
  },
}
const catalog: BlueprintComponents = {
  components: [{
    type: 'Input', installed: true, slots: [], events: [{ name: 'onChange', prop: 'onChange' }],
    exposes: [{ name: 'value', type: 'string', initial: '', via: { valueProp: 'value', changeProp: 'onChange', changeArg: 'event.target.value' } }],
  }],
  schemas: { Input: { properties: { placeholder: { type: 'string' } } } },
}

it('FR-DS-03 proposes binding mode locally then saves a guarded binding', async () => {
  const commit = vi.fn()
  const ui = await mount(<NodeProps document={document} catalog={catalog} nodeId="input" diagnostics={[]} commit={commit} />)
  try {
    expect(ui.host.textContent).toContain('ui.search.value')
    expect(ui.host.textContent).toContain('onChange')
    const mode = find<HTMLSelectElement>(ui.host, 'select[aria-label="placeholder mode"]')
    await act(async () => {
      mode.value = 'binding'
      mode.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(commit).not.toHaveBeenCalled()
    const save = [...ui.host.querySelectorAll('button')].find((button) => button.textContent === 'Save expression')
    expect(save).toBeDefined()
    await act(async () => save!.click())
    expect(commit).toHaveBeenCalledExactlyOnceWith([{
      op: 'setBinding', prop: 'placeholder', expr: '"Search"', doc: document.path, baseRev: 'saved', node: 'input', expectedType: 'Input',
    }], 'Blueprint: bind search.placeholder')
  } finally {
    await ui.unmount()
  }
})
