// A contract enum's options in place (src/refine/options.ts): which edits bring a site's values
// to the contract's, the ops each kind of site gets, and how locators move under JSX edits.

import { describe, expect, it } from 'vitest'

import { type ReadableSite, arrayOps, itemOps, optionEdits, readableSite, removedValues, sameSet, selectItem, shiftLocator } from '../src/refine/options.js'

/** The site's values after the edits, applied as the ops would apply them. */
function applied(have: string[], want: string[]): string[] {
  const list = [...have]
  for (const e of optionEdits(have, want)) {
    if (e.kind === 'insert') list.splice(e.index, 0, e.value)
    else list.splice(list.indexOf(e.value), 1)
  }
  return list
}

describe('optionEdits', () => {
  it('puts a new value after the nearest one before it in the contract, and removes nothing it still has', () => {
    expect(optionEdits(['suspended', 'pending', 'active'], ['pending', 'active', 'review', 'suspended'])).toEqual([
      { kind: 'insert', value: 'review', index: 3, anchor: { value: 'active', placement: 'after' } },
    ])
    expect(applied(['suspended', 'pending', 'active'], ['pending', 'active', 'review', 'suspended'])).toEqual(['suspended', 'pending', 'active', 'review'])
  })

  it('replaces every value: inserts after the last item, in contract order, then removes', () => {
    expect(optionEdits(['a', 'b'], ['x', 'y'])).toEqual([
      { kind: 'insert', value: 'x', index: 2, anchor: { value: 'b', placement: 'after' } },
      { kind: 'insert', value: 'y', index: 3, anchor: { value: 'x', placement: 'after' } },
      { kind: 'remove', value: 'a' },
      { kind: 'remove', value: 'b' },
    ])
    expect(applied(['a', 'b'], ['x', 'y'])).toEqual(['x', 'y'])
  })

  it('goes before the nearest value after it when none before it is there', () => {
    expect(optionEdits(['b', 'c'], ['a', 'b', 'c'])).toEqual([{ kind: 'insert', value: 'a', index: 0, anchor: { value: 'b', placement: 'before' } }])
    expect(applied(['c', 'b'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'd', 'a', 'b'])
    // An empty literal gets the values in contract order, with nothing to stand next to.
    expect(optionEdits([], ['a'])).toEqual([{ kind: 'insert', value: 'a', index: 0, anchor: null }])
    expect(optionEdits(['a', 'b'], ['b', 'a'])).toEqual([])
  })
})

describe('sites', () => {
  const items = (...values: string[]) => values.map((value, i) => ({ value, line: i + 1 }))

  it('compares sets, so a duplicate is never "the same", and blocks what it cannot splice', () => {
    expect(sameSet(['a', 'a'], ['a', 'b'])).toBe(false)
    expect(sameSet(['b', 'a'], ['a', 'b'])).toBe(true)
    expect(readableSite('rule', 'f#module#s.x', items('a', 'b')).state).toBe('literal')
    expect(readableSite('rule', 'f#module#s.x', items('a', 'a'))).toMatchObject({ state: 'blocked', why: '"a" is written twice' })
    expect(readableSite('column', 'p', items('a]', 'b')).state).toBe('blocked')
    const guarded = [{ value: 'a', line: 1, locator: 'f#C#0.0', direct: true }, { value: 'b', line: 2, locator: 'f#C#0.1', direct: false }]
    expect(readableSite('items', 'f#C', guarded).state).toBe('blocked')
  })

  it('writes value ops for an array site and keyed paths for its removals', () => {
    const rule = readableSite('rule', 'src/e.tsx#module#schema.status', items('pending', 'suspended'))
    expect(arrayOps(rule, optionEdits(['pending', 'suspended'], ['pending', 'closed']))).toEqual([
      { op: 'insertElement', path: 'src/e.tsx#module#schema.status', index: 1, value: '"closed"' },
      { op: 'removeElement', path: 'src/e.tsx#module#schema.status[=suspended]' },
    ])
    const column = readableSite('column', 'src/l.tsx#L#columns[id=status].header<DataTableFilterCombobox>.options', items('pending'))
    expect(arrayOps(column, optionEdits(['pending'], ['not_started', 'pending']))).toEqual([
      { op: 'insertElement', path: column.at, index: 0, value: '{ label: "Not started", value: "not_started" }' },
    ])
    expect(arrayOps(column, [{ kind: 'remove', value: 'pending' }])).toEqual([{ op: 'removeElement', path: `${column.at}[value=pending]` }])
  })

  it('writes SelectItems next to their anchors and tracks the locators each edit moves', () => {
    // Read with the control at …#0.2; earlier changes in the plan have moved it to …#0.3.
    const site: ReadableSite = {
      kind: 'items',
      state: 'literal',
      at: 'f#Edit#0.2',
      items: [
        { value: 'pending', line: 10, locator: 'f#Edit#0.2.0.1.0', direct: true },
        { value: 'suspended', line: 11, locator: 'f#Edit#0.2.0.1.1', direct: true },
      ],
    }
    const shifts: Array<[string, number]> = []
    const ops = itemOps(site, optionEdits(['pending', 'suspended'], ['closed', 'pending']), 'f#Edit#0.3', (at, by) => shifts.push([at, by]))
    expect(ops).toEqual([
      // `closed` goes before `pending`, the nearest value after it: then `pending` is at 1 and `suspended` at 2.
      { op: 'insert', target: 'f#Edit#0.3.0.1.0', expectedName: 'SelectItem', placement: 'before', snippet: '<SelectItem value="closed">Closed</SelectItem>' },
      { op: 'remove', target: 'f#Edit#0.3.0.1.2', expectedName: 'SelectItem' },
    ])
    expect(shifts).toEqual([['f#Edit#0.3.0.1.0', 1], ['f#Edit#0.3.0.1.2', -1]])
    expect(selectItem('a"b')).toBe('<SelectItem value={"a\\"b"}>A"b</SelectItem>')
    expect(selectItem('in_review')).toBe('<SelectItem value="in_review">In review</SelectItem>')
  })

  it('leaves out the lines an align rewrites when it looks for leftovers', () => {
    const rule = readableSite('rule', 'p', [{ value: 'pending', line: 34 }, { value: 'suspended', line: 34 }])
    const items: ReadableSite = { kind: 'items', state: 'literal', at: 'c', items: [{ value: 'pending', line: 113 }, { value: 'suspended', line: 115 }] }
    const { removed, own } = removedValues([rule, items], ['pending', 'closed'], { value: 'suspended', line: 53 })
    expect(removed).toEqual(['suspended'])
    expect([...own].sort((a, b) => a - b)).toEqual([34, 53, 115])
    expect([...removedValues([rule], ['pending', 'closed'], { value: 'pending', line: 53 }).own]).toEqual([34])
  })
})

describe('shiftLocator', () => {
  const at = 'f#C#0.1.2'
  it('moves the later siblings and what is inside them on an insert, from the slot on', () => {
    expect(shiftLocator('f#C#0.1.2', at, 1)).toBe('f#C#0.1.3')
    expect(shiftLocator('f#C#0.1.4.0.1', at, 1)).toBe('f#C#0.1.5.0.1')
    expect(shiftLocator('f#C#0.1.1', at, 1)).toBe('f#C#0.1.1')
    expect(shiftLocator('f#C#0.1', at, 1)).toBe('f#C#0.1')
  })

  it('moves only what comes after a removed element', () => {
    expect(shiftLocator('f#C#0.1.3', at, -1)).toBe('f#C#0.1.2')
    expect(shiftLocator('f#C#0.1.3.1', at, -1)).toBe('f#C#0.1.2.1')
    expect(shiftLocator('f#C#0.1.1.9', at, -1)).toBe('f#C#0.1.1.9')
  })

  it('leaves other parents, components and files alone', () => {
    expect(shiftLocator('f#C#0.2.3', at, 1)).toBe('f#C#0.2.3')
    expect(shiftLocator('f#D#0.1.3', at, 1)).toBe('f#D#0.1.3')
    expect(shiftLocator('g#C#0.1.3', at, -1)).toBe('g#C#0.1.3')
  })
})
