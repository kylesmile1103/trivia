import { describe, expect, it } from 'vitest'

import { dropPlacement } from './tree-drop'

const H = 28
const leaf = { root: false, hasChildren: false, expanded: false }
const closed = { root: false, hasChildren: true, expanded: false }
const open = { root: false, hasChildren: true, expanded: true }

describe('where a dropped layer lands on a row', () => {
  it('splits a leaf in halves: before or after it', () => {
    expect(dropPlacement(2, H, leaf)).toBe('before')
    expect(dropPlacement(13, H, leaf)).toBe('before')
    expect(dropPlacement(15, H, leaf)).toBe('after')
    expect(dropPlacement(27, H, leaf)).toBe('after')
  })

  it('takes a collapsed container in quarters: before, inside, after', () => {
    expect(dropPlacement(5, H, closed)).toBe('before')
    expect(dropPlacement(14, H, closed)).toBe('inside')
    expect(dropPlacement(24, H, closed)).toBe('after')
  })

  it("reads an open container's bottom edge as inside: its first child sits right there", () => {
    expect(dropPlacement(5, H, open)).toBe('before')
    expect(dropPlacement(14, H, open)).toBe('inside')
    expect(dropPlacement(26, H, open)).toBe('inside')
  })

  it("only goes inside a component's root: it has no sibling slot", () => {
    for (const y of [1, 14, 27]) expect(dropPlacement(y, H, { ...open, root: true })).toBe('inside')
    expect(dropPlacement(1, H, { ...leaf, root: true })).toBe('inside')
  })
})
