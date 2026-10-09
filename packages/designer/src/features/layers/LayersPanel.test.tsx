// @vitest-environment jsdom
//
// The layers panel over a stub canvas: rows select and hover through the store, collapse on
// their chevron, and the selection's row stays revealed. Rows drag onto rows (before, after,
// inside) and Alt+↑/↓ moves the selected one, both through the canvas API.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
let api: { move: ReturnType<typeof vi.fn>; moveStep: ReturnType<typeof vi.fn>; refusal: string | null }

beforeEach(() => {
  tree = [
    layer('0', 'main', [
      layer('0.0', 'Card', [layer('0.0.0', 'CardTitle', [], { text: 'Settings' }), layer('0.0.1', 'Button', [], { text: 'Save' })]),
      layer('0.1', 'li', [], { count: 3 }),
    ]),
  ]
  api = { move: vi.fn(async () => {}), moveStep: vi.fn(async () => {}), refusal: null }
  setCanvasApi({
    layers: () => tree,
    version: () => 7,
    moveRefusal: (locator: string) => (locator === at('0.1') ? 'it is rendered from a {…} expression' : api.refusal),
    move: api.move,
    moveStep: api.moveStep,
  } as unknown as CanvasApi)
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

/** A drag event jsdom can carry (it has no DragEvent or DataTransfer): one transfer per drag. */
function dragger() {
  const data = new Map<string, string>()
  const dataTransfer = {
    effectAllowed: 'all',
    dropEffect: 'none',
    get types() {
      return [...data.keys()]
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  }
  return async (el: Element, type: string, clientY = 0): Promise<Event> => {
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer, clientY })
    await act(async () => el.dispatchEvent(event))
    return event
  }
}

/** Give a row a box 28 px tall at y = 100, as the browser would lay it out. */
function placed(el: Element): Element {
  el.getBoundingClientRect = () => ({ x: 0, y: 100, top: 100, bottom: 128, left: 0, right: 240, width: 240, height: 28, toJSON() {} })
  return el
}

describe('moving layers', () => {
  it('drops a row before another: one canvas move, with the version the tree was read at', async () => {
    ui = await mount(<LayersPanel />)
    const fire = dragger()
    await fire(row('0.0.1'), 'dragstart')
    const over = await fire(placed(row('0.0.0')), 'dragover', 102)
    expect(over.defaultPrevented).toBe(true)
    expect(row('0.0.0').getAttribute('data-drop')).toBe('before')
    await fire(row('0.0.0'), 'drop', 102)
    expect(api.move).toHaveBeenCalledWith(at('0.0.1'), at('0.0.0'), 'before', 7)
    expect(row('0.0.0').getAttribute('data-drop')).toBeNull()
  })

  it('drops into the middle of a container as its first child, and below a leaf after it', async () => {
    ui = await mount(<LayersPanel />)
    let fire = dragger()
    await fire(row('0.0.1'), 'dragstart')
    await fire(placed(row('0.0')), 'dragover', 114)
    expect(row('0.0').getAttribute('data-drop')).toBe('inside')
    await fire(row('0.0'), 'drop', 114)
    expect(api.move).toHaveBeenLastCalledWith(at('0.0.1'), at('0.0'), 'inside', 7)

    fire = dragger()
    await fire(row('0.0.0'), 'dragstart')
    await fire(placed(row('0.0.1')), 'drop', 125)
    expect(api.move).toHaveBeenLastCalledWith(at('0.0.0'), at('0.0.1'), 'after', 7)
  })

  it("refuses at once what the canvas can't move, and drops nothing", async () => {
    ui = await mount(<LayersPanel />)
    const fire = dragger()
    const start = await fire(row('0.1'), 'dragstart')
    expect(start.defaultPrevented).toBe(true)
    const over = await fire(placed(row('0.0.0')), 'dragover', 102)
    expect(over.defaultPrevented).toBe(false)
    await fire(row('0.0.0'), 'drop', 102)
    expect(api.move).not.toHaveBeenCalled()
  })

  it('never drops a layer onto itself or into its own subtree', async () => {
    ui = await mount(<LayersPanel />)
    const fire = dragger()
    await fire(row('0.0'), 'dragstart')
    for (const target of ['0.0', '0.0.1']) {
      const over = await fire(placed(row(target)), 'dragover', 114)
      expect(over.defaultPrevented).toBe(false)
      expect(row(target).getAttribute('data-drop')).toBeNull()
      await fire(row(target), 'drop', 114)
    }
    expect(api.move).not.toHaveBeenCalled()
  })

  it('ignores drags that are not layers (a palette template)', async () => {
    ui = await mount(<LayersPanel />)
    const fire = dragger()
    const over = await fire(placed(row('0.0.0')), 'dragover', 102)
    expect(over.defaultPrevented).toBe(false)
  })

  it('moves the focused row a sibling up or down on Alt+↑/↓, and keeps focus on it', async () => {
    ui = await mount(<LayersPanel />)
    await click(row('0.0.1'))
    const key = async (el: Element, k: string) =>
      act(async () => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, altKey: true, bubbles: true, cancelable: true })))
    await key(row('0.0.1'), 'ArrowUp')
    expect(api.moveStep).toHaveBeenCalledWith(at('0.0.1'), 'up', 7)

    // The edit lands: the button is now first in the card, and the selection followed it.
    tree = [
      layer('0', 'main', [
        layer('0.0', 'Card', [layer('0.0.0', 'Button', [], { text: 'Save' }), layer('0.0.1', 'CardTitle', [], { text: 'Settings' })]),
        layer('0.1', 'li', [], { count: 3 }),
      ]),
    ]
    await act(async () => {
      designer.getState().select(at('0.0.0'))
      designer.getState().bumpRevision()
    })
    await settle()
    expect(document.activeElement).toBe(row('0.0.0'))
    await key(row('0.0.0'), 'ArrowDown')
    expect(api.moveStep).toHaveBeenLastCalledWith(at('0.0.0'), 'down', 7)
  })
})
