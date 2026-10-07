import { describe, expect, it } from 'vitest'

import { placementFor } from '@/registry/insert'

describe('placementFor', () => {
  it('inserts into containers as the last child', () => {
    expect(placementFor({ name: 'CardContent' }, true)).toBe('lastChild')
    expect(placementFor({ name: 'div' }, undefined)).toBe('lastChild')
  })

  it('inserts after components and elements that take no children', () => {
    expect(placementFor({ name: 'Input' }, false)).toBe('after')
    expect(placementFor({ name: 'input' }, undefined)).toBe('after')
    expect(placementFor({ name: 'img' }, undefined)).toBe('after')
  })
})
