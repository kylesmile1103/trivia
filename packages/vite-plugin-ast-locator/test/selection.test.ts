import { describe, expect, it } from 'vitest'

import { SelectionStore, rebase } from '../src/api/selection.js'

const at = (path: string, scope = 'Page', file = 'src/Page.tsx') => `${file}#${scope}#${path}`

describe('rebase: where the selected node is after an op', () => {
  it('an insert before it, or before an earlier sibling or ancestor, shifts it along', () => {
    const insert = { op: 'insert', target: at('0.1'), expectedName: 'Button', placement: 'before', snippet: '<Badge />' }
    // The new node lands at 0.1: the old 0.1 and everything after it at that depth moves up one.
    expect(rebase(at('0.1'), insert, at('0.1'))).toBe(at('0.2'))
    expect(rebase(at('0.2.3'), insert, at('0.1'))).toBe(at('0.3.3'))
    expect(rebase(at('0.0'), insert, at('0.1'))).toBe(at('0.0'))
    expect(rebase(at('0'), insert, at('0.1'))).toBe(at('0'))
  })

  it('an insert after it or into it leaves it where it is', () => {
    expect(rebase(at('0.1'), { op: 'insert', target: at('0.1'), placement: 'after' }, at('0.2'))).toBe(at('0.1'))
    expect(rebase(at('0.1'), { op: 'insert', target: at('0.1'), placement: 'lastChild' }, at('0.1.4'))).toBe(at('0.1'))
    expect(rebase(at('0.1.2'), { op: 'insertChild', parent: at('0.1'), index: 1 }, at('0.1.1'))).toBe(at('0.1.3'))
  })

  it('a remove drops it with its subtree, and shifts later siblings back', () => {
    const remove = { op: 'remove', target: at('0.1'), expectedName: 'Card' }
    expect(rebase(at('0.1'), remove, null)).toBeNull()
    expect(rebase(at('0.1.2'), remove, null)).toBeNull()
    expect(rebase(at('0.2'), remove, null)).toBe(at('0.1'))
    expect(rebase(at('0.2.5'), remove, null)).toBe(at('0.1.5'))
    expect(rebase(at('0.0'), remove, null)).toBe(at('0.0'))
  })

  it('a move takes it along with its subtree, and shifts what the move passes', () => {
    // 0.1 moved after the old 0.3: out of 0.1 (0.2 and 0.3 move back), into 0.3 (0.3 on moves up).
    const move = { op: 'move', source: at('0.1'), target: at('0.3'), placement: 'after' }
    expect(rebase(at('0.1'), move, at('0.3'))).toBe(at('0.3'))
    expect(rebase(at('0.1.0'), move, at('0.3'))).toBe(at('0.3.0'))
    expect(rebase(at('0.2'), move, at('0.3'))).toBe(at('0.1'))
    expect(rebase(at('0.3'), move, at('0.3'))).toBe(at('0.2'))
    expect(rebase(at('0.4'), move, at('0.3'))).toBe(at('0.4'))
    // moveNode works the same way.
    expect(rebase(at('0.0'), { op: 'moveNode', source: at('0.2'), parent: at('0'), index: 0 }, at('0.0'))).toBe(at('0.1'))
  })

  it('edits that add or remove no element leave it alone', () => {
    for (const op of [
      { op: 'updateProp', target: at('0.1'), prop: 'variant', value: 'outline' },
      { op: 'setText', target: at('0.1'), text: 'Save' },
      { op: 'bindQuery', target: at('0.1') },
    ]) {
      expect(rebase(at('0.1'), op, at('0.1')), op.op).toBe(at('0.1'))
      expect(rebase(at('0.2'), op, at('0.1')), op.op).toBe(at('0.2'))
    }
  })

  it('only nodes of the same file and component shift', () => {
    const insert = { op: 'insert', target: at('0.1'), placement: 'before' }
    expect(rebase(at('0.2', 'Other'), insert, at('0.1'))).toBe(at('0.2', 'Other'))
    expect(rebase(at('0.2', 'Page', 'src/Other.tsx'), insert, at('0.1'))).toBe(at('0.2', 'Page', 'src/Other.tsx'))
  })

  it('gives up (null) rather than guess', () => {
    expect(rebase(at('0.2'), { op: 'insert', target: at('0.1'), placement: 'before' }, null)).toBeNull()
    expect(rebase(at('0.2'), { op: 'explode' }, at('0.1'))).toBeNull()
    expect(rebase('not a locator', { op: 'remove', target: at('0.1') }, null)).toBeNull()
  })
})

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
