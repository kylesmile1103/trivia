// @vitest-environment jsdom
//
// The canvas's layer tree, built from the app's DOM the way selection reads it: usage-site
// locators only (CLAUDE.md rule 5), nested as rendered, `.map()` copies counted once.

import { describe, expect, it } from 'vitest'

import { layerTree } from './dom'

const UI = 'src/components/ui'
const at = (path: string) => `src/pages/Home.tsx#Home#${path}`
const lib = (path: string) => `${UI}/card.tsx#Card#${path}`

function doc(html: string): Document {
  const d = document.implementation.createHTMLDocument('app')
  d.body.innerHTML = html
  return d
}

const names = (_locator: string, el: Element) => el.getAttribute('data-slot') ?? el.tagName.toLowerCase()

describe('layerTree', () => {
  it('nests usage-site elements as rendered, skipping the library’s own', () => {
    const d = doc(`
      <main data-ast-node="${at('0')}">
        <div data-slot="card" data-ast-node="${at('0.0')}">
          <div data-ast-node="${lib('0.0')}">
            <h2 data-ast-node="${at('0.0.0')}">Title</h2>
          </div>
          <button data-slot="button" data-ast-node="${at('0.0.1')}">Save <svg data-ast-node="${lib('0.1')}"></svg></button>
        </div>
      </main>`)
    expect(layerTree(d, UI, names)).toEqual([
      {
        locator: at('0'),
        name: 'main',
        count: 1,
        text: null,
        children: [
          {
            locator: at('0.0'),
            name: 'card',
            count: 1,
            text: null,
            children: [
              { locator: at('0.0.0'), name: 'h2', count: 1, text: 'Title', children: [] },
              { locator: at('0.0.1'), name: 'button', count: 1, text: null, children: [] },
            ],
          },
        ],
      },
    ])
  })

  it('counts the copies .map() renders, once per locator', () => {
    const d = doc(`
      <ul data-ast-node="${at('0')}">
        <li data-ast-node="${at('0.0')}"><b data-ast-node="${at('0.0.0')}">a</b></li>
        <li data-ast-node="${at('0.0')}"><b data-ast-node="${at('0.0.0')}">b</b></li>
        <li data-ast-node="${at('0.0')}"><b data-ast-node="${at('0.0.0')}">c</b></li>
      </ul>`)
    const [list] = layerTree(d, UI, names)
    expect(list?.children).toEqual([
      { locator: at('0.0'), name: 'li', count: 3, text: null, children: [{ locator: at('0.0.0'), name: 'b', count: 3, text: 'a', children: [] }] },
    ])
  })

  it('is empty for a page without locators', () => {
    expect(layerTree(doc('<p>plain</p>'), UI, names)).toEqual([])
  })
})
