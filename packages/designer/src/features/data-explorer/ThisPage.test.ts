// The add menu's tooltip: a field's contract bounds in a few words.

import { describe, expect, it } from 'vitest'

import { boundsText } from './ThisPage'

describe('boundsText', () => {
  it('says each bound the contract declares, and nothing when there are none', () => {
    expect(boundsText(null)).toBeUndefined()
    expect(boundsText({})).toBeUndefined()
    expect(boundsText({ minLength: 2, maxLength: 120 })).toBe('2–120 characters')
    expect(boundsText({ maxLength: 1000 })).toBe('at most 1000 characters')
    expect(boundsText({ minLength: 4, pattern: '^[0-9]+$' })).toBe('at least 4 characters, matches /^[0-9]+$/')
    expect(boundsText({ exclusiveMinimum: 0, maximum: 10000 })).toBe('> 0, ≤ 10000')
  })
})
