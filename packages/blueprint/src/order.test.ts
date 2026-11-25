import { describe, expect, it } from 'vitest'
import { isOrderKey, keyBetween, keysBetween, ORDER_DIGITS } from './order.js'

const minInteger = 'A' + '0'.repeat(26)
const maxInteger = 'z'.repeat(27)

describe('isOrderKey', () => {
  it('accepts base-62 integers and fractions with no trailing zero', () => {
    expect(ORDER_DIGITS).toBe('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')
    for (const key of ['a0', 'a0V', 'a00V', 'b00', 'Zz', 'Y00', minInteger + 'V', maxInteger]) {
      expect(isOrderKey(key)).toBe(true)
    }
  })

  it('rejects malformed keys and the reserved smallest integer', () => {
    for (const key of ['', 'a', 'b0', 'A0', '0a', 'é0', 'a?', 'a0_', 'a0\n', 'a00', 'a0V0', minInteger]) {
      expect(isOrderKey(key)).toBe(false)
    }
  })
})

describe('keyBetween', () => {
  it('starts at a0 and appends consecutive integer keys', () => {
    const first = keyBetween(null, null)
    const second = keyBetween(first, null)
    expect([first, second, keyBetween(second, null)]).toEqual(['a0', 'a1', 'a2'])
  })

  it('prepends consecutive integer keys below a0', () => {
    const first = keyBetween(null, 'a0')
    expect(first).toBe('Zz')
    expect(keyBetween(null, first)).toBe('Zy')
  })

  const cases = [
    ['az', null, 'b00'],
    ['Zz', null, 'a0'],
    ['Yzz', null, 'Z0'],
    [null, 'b00', 'az'],
    [null, 'Z0', 'Yzz'],
    [null, 'a0V', 'a0'],
    ['a0V', null, 'a1'],
    ['a0', 'a1', 'a0V'],
    ['a0', 'a00V', 'a00G'],
    ['a0', 'a01V', 'a01'],
    ['a0V', 'a0W', 'a0VV'],
    ['a0V', 'a2', 'a1'],
    [null, minInteger.slice(0, -1) + '1', minInteger + 'V'],
    [null, minInteger + 'V', minInteger + 'G'],
    [maxInteger, null, maxInteger + 'V'],
  ] as const

  it('returns valid shortest midpoints and handles integer rollovers', () => {
    for (const [a, b, expected] of cases) {
      const key = keyBetween(a, b)
      expect(key).toBe(expected)
      expect(isOrderKey(key)).toBe(true)
      expect(a === null || a < key).toBe(true)
      expect(b === null || key < b).toBe(true)
    }
  })

  it('throws RangeError for malformed or unordered bounds', () => {
    for (const [a, b] of [['a00', 'a1'], ['a0', 'b0'], [minInteger, null], ['a0', 'a0'], ['a1', 'a0']] as const) {
      expect(() => keyBetween(a, b)).toThrow(RangeError)
    }
  })

  const positions = [
    { label: 'right after the fixed first key', index: () => 1 },
    { label: 'at the start', index: () => 0 },
    { label: 'at the end', index: (keys: string[]) => keys.length },
  ]

  it.each(positions)('preserves order and uniqueness for 1,000 inserts $label', ({ label, index }) => {
    const keys = ['a0', 'a1', 'a2']
    let longest = ''
    for (let insert = 0; insert < 1_000; insert++) {
      const at = index(keys)
      const key = keyBetween(keys[at - 1] ?? null, keys[at] ?? null)
      keys.splice(at, 0, key)
      if (key.length > longest.length) longest = key

      expect(isOrderKey(key)).toBe(true)
      expect(keys.every((current, position) => current > (keys[position - 1] ?? ''))).toBe(true)
      expect(new Set(keys).size).toBe(keys.length)
    }
    console.log(`Longest key ${label}: ${longest.length} characters (${longest})`)
  })
})

describe('keysBetween', () => {
  it('spreads keys through a bounded range in bytewise order', () => {
    expect(keysBetween('a0', 'a1', 3)).toEqual(['a0G', 'a0V', 'a0l'])

    const keys = keysBetween('Zz', 'a1', 12)
    expect(keys).toHaveLength(12)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every((key, index) => isOrderKey(key) && (keys[index - 1] ?? 'Zz') < key && key < 'a1')).toBe(true)
  })

  it('returns sorted keys for open bounds and an empty array for zero keys', () => {
    expect(keysBetween(null, null, 3)).toEqual(['a0', 'a1', 'a2'])
    expect(keysBetween(null, 'a0', 3)).toEqual(['Zx', 'Zy', 'Zz'])
    expect(keysBetween('a0', null, 3)).toEqual(['a1', 'a2', 'a3'])
    expect(keysBetween('a0', 'a1', 0)).toEqual([])
  })

  it('throws RangeError for invalid counts and bounds', () => {
    for (const n of [-1, 1.5, NaN, Infinity, 2 ** 32]) {
      expect(() => keysBetween('a0', 'a1', n)).toThrow(RangeError)
    }
    expect(() => keysBetween('a1', 'a0', 2)).toThrow(RangeError)
    expect(() => keysBetween(null, 'a00', 1)).toThrow(RangeError)
  })
})
