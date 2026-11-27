import { describe, expect, it } from 'vitest'

import { SelectionStore } from '../src/api/selection.js'

const at = (path: string, scope = 'Page', file = 'src/Page.tsx') => `${file}#${scope}#${path}`

describe('SelectionStore', () => {
  it('versions every change and says who made it', () => {
    const store = new SelectionStore()
    expect(store.get()).toEqual({ selection: null, version: 0, by: null })
    store.set({ locator: at('0.1'), name: 'Button' }, 'designer')
    expect(store.get()).toEqual({ selection: { locator: at('0.1'), name: 'Button' }, version: 1, by: 'designer' })
    store.set({ locator: at('0.2'), name: 'Button' }, 'agent')
    expect(store.get()).toMatchObject({ version: 2, by: 'agent' })
    store.set(null, 'designer')
    expect(store.get()).toEqual({ selection: null, version: 3, by: 'designer' })
  })

  it('ignores a repeat of what it already holds', () => {
    const store = new SelectionStore()
    store.set({ locator: at('0.1'), name: 'Button' }, 'agent')
    store.set({ locator: at('0.1'), name: 'Button' }, 'designer')
    expect(store.get()).toMatchObject({ version: 1, by: 'agent' })
  })
})
