// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'

import type { BlueprintComponents, BlueprintDocument, CustomPage } from '@/shared/engine/types'
import { find, mount } from '@/shared/lib/test-utils'

import { destinationFor, NodeTree } from './NodeTree'

const catalog: BlueprintComponents = {
  components: [
    { type: 'div', installed: true, slots: [{ name: 'children', kind: 'nodes' }], events: [], exposes: [] },
    { type: 'Card', installed: false, slots: [{ name: 'content', kind: 'nodes' }], events: [], exposes: [] },
    { type: 'Input', installed: true, slots: [], events: [], exposes: [] },
  ],
  schemas: {},
}
const draft: BlueprintDocument<CustomPage> = {
  path: 'pages/Editor.page.json', rev: 'saved',
  doc: {
    $schema: 'page', blueprintVersion: 1, name: 'Editor', id: 'page', route: '/editor', kind: 'custom', public: false,
    root: 'root', nodes: {
      root: { type: 'div', name: 'page', parent: null, slot: null, order: 'a0' },
      search: { type: 'Input', name: 'search', parent: 'root', slot: 'children', order: 'a2' },
      card: { type: 'Card', name: 'card', parent: 'root', slot: 'children', order: 'a1' },
      nested: { type: 'div', name: 'nested', parent: 'card', slot: 'content', order: 'a0' },
    },
    props: {}, bindings: {}, styles: {}, control: {}, state: {}, queries: {}, actions: {},
  },
}

it('FR-DS-03 orders rows by their keys and adds from the manifest catalog with a parent guard', async () => {
  const save = vi.fn().mockResolvedValue(true)
  const ui = await mount(<NodeTree document={draft} catalog={catalog} selected="root" onSelect={vi.fn()} save={save} />)
  try {
    expect([...ui.host.querySelectorAll('[data-bp-tree-node]')].map((row) => row.getAttribute('data-bp-tree-node')))
      .toEqual(['root', 'card', 'nested', 'search'])
    const select = find<HTMLSelectElement>(ui.host, 'select[name="component"]')
    expect(select.textContent).toContain('Card (not installed)')
    await act(async () => {
      select.value = 'Card'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const form = find<HTMLFormElement>(ui.host, 'form[aria-label="Add node"]')
    await act(async () => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenCalledExactlyOnceWith({
      op: 'addNode', doc: draft.path, baseRev: 'saved', parent: 'root', expectedType: 'div',
      type: 'Card', name: 'nodeCard', slot: 'children',
    }, 'Blueprint: add nodeCard to Editor')
  } finally {
    await ui.unmount()
  }
})

it('FR-DS-03 addresses a sibling or a compatible slot and refuses cycles and root moves', () => {
  const move = (source: string, target: string, placement: 'before' | 'after' | 'inside') =>
    destinationFor(draft.doc, catalog.components, source, target, placement)
  expect(move('search', 'card', 'before')).toEqual({ parent: 'root', slot: 'children', before: 'card' })
  expect(move('search', 'card', 'inside')).toEqual({ parent: 'card', slot: 'content', index: 0 })
  expect(move('search', 'nested', 'after')).toEqual({ parent: 'card', slot: 'content', after: 'nested' })
  expect(move('card', 'nested', 'inside')).toBeNull()
  expect(move('card', 'search', 'inside')).toBeNull()
  expect(move('root', 'card', 'inside')).toBeNull()
})
