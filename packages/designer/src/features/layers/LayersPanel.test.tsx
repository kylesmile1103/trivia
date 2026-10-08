// @vitest-environment jsdom
//
// The layers panel over a stub canvas: rows select and hover through the store, collapse on
// their chevron, and the selection's row stays revealed.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type CanvasApi, type Layer, setCanvasApi } from '@/shared/canvas'
import { find, type Mounted, mount, settle } from '@/shared/lib/test-utils'
import { designer } from '@/shared/state/store'

import { LayersPanel } from './LayersPanel'

const at = (path: string) => `src/pages/Home.tsx#Home#${path}`
const layer = (path: string, name: string, children: Layer[] = [], extra: Partial<Layer> = {}): Layer => ({
  locator: at(path),
  name,
  count: 1,
  text: null,
  children,
  ...extra,
})

let tree: Layer[]
let ui: Mounted | null = null

beforeEach(() => {
  tree = [
    layer('0', 'main', [
      layer('0.0', 'Card', [layer('0.0.0', 'CardTitle', [], { text: 'Settings' }), layer('0.0.1', 'Button', [], { text: 'Save' })]),
      layer('0.1', 'li', [], { count: 3 }),
    ]),
  ]
  setCanvasApi({ layers: () => tree } as unknown as CanvasApi)
  designer.setState({ selected: null, hovered: null, details: null, revision: 0 })
  Element.prototype.scrollIntoView = () => {}
})

afterEach(async () => {
  await ui?.unmount()
  ui = null
  setCanvasApi(null)
})

const row = (path: string) => find(document, `[data-layer="${at(path)}"]`)
const click = async (el: Element) => act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))

describe('the layers panel', () => {
  it('shows the tree with names, texts and .map() counts', async () => {
    ui = await mount(<LayersPanel />)
    const rows = [...document.querySelectorAll('[role=treeitem]')].map((r) => r.textContent)
    expect(rows).toEqual(['main', 'Card', 'CardTitleSettings', 'ButtonSave', 'li×3'])
    expect(row('0.0').getAttribute('aria-level')).toBe('2')
    expect(row('0.0.1').getAttribute('aria-label')).toBe('Button Save')
    expect(row('0.1').getAttribute('aria-label')).toBe('li ×3')
  })

  it('selects on click and highlights on hover, through the store', async () => {
    ui = await mount(<LayersPanel />)
    await click(row('0.0.1'))
    expect(designer.getState().selected).toBe(at('0.0.1'))
    expect(row('0.0.1').getAttribute('aria-selected')).toBe('true')
    await act(async () => row('0.1').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(designer.getState().hovered).toBe(at('0.1'))
    await act(async () => row('0.1').dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    expect(designer.getState().hovered).toBeNull()
  })

  it('collapses on the chevron, but keeps the selection’s ancestors open', async () => {
    ui = await mount(<LayersPanel />)
    await click(find(row('0.0'), 'button[title="Collapse"]'))
    expect(document.querySelector(`[data-layer="${at('0.0.1')}"]`)).toBeNull()
    expect(row('0.0').getAttribute('aria-expanded')).toBe('false')
    await act(async () => designer.getState().select(at('0.0.1')))
    await settle()
    expect(row('0.0.1').getAttribute('aria-selected')).toBe('true')
  })

  it('reads the tree again after a re-render', async () => {
    ui = await mount(<LayersPanel />)
    tree = [layer('0', 'section')]
    await act(async () => designer.getState().bumpRevision())
    expect([...document.querySelectorAll('[role=treeitem]')].map((r) => r.textContent)).toEqual(['section'])
  })

  it('says so when nothing carries a locator', async () => {
    tree = []
    ui = await mount(<LayersPanel />)
    expect(document.body.textContent).toContain('Nothing on the canvas carries a locator yet.')
  })
})
