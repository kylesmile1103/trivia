import { describe, expect, it } from 'vitest'
import { encodeUlid, newId, sequenceSource, ULID_ALPHABET, ULID_SOURCE, ulidSource } from './ids.js'

describe('encodeUlid', () => {
  it('encodes the ULID alphabet and known boundary values', () => {
    const zero = new Uint8Array(10)
    expect(ULID_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ')
    expect(ULID_SOURCE).toBe('[0-7][0-9A-HJKMNP-TV-Z]{25}')
    expect(encodeUlid(0, zero)).toBe('0'.repeat(26))
    expect(encodeUlid(1, zero)).toBe('0000000001' + '0'.repeat(16))
    expect(encodeUlid(2 ** 48 - 1, zero)).toBe('7' + 'Z'.repeat(9) + '0'.repeat(16))
    expect(encodeUlid(2 ** 48 - 1, zero.fill(255))).toBe('7' + 'Z'.repeat(25))
  })

  it('sorts by time even when the random bits decrease', () => {
    expect(encodeUlid(31, new Uint8Array(10).fill(255)) < encodeUlid(32, new Uint8Array(10))).toBe(true)
  })

  it('rejects timestamps outside the 48-bit integer range', () => {
    for (const time of [-1, 0.5, 2 ** 48, NaN, Infinity]) {
      expect(() => encodeUlid(time, new Uint8Array(10))).toThrow(RangeError)
    }
  })

  it('rejects random inputs with a byte length other than ten', () => {
    for (const size of [0, 9, 11]) {
      expect(() => encodeUlid(0, new Uint8Array(size))).toThrow(RangeError)
    }
  })
})

describe('ulidSource', () => {
  it('increments the random part when the clock stays put or goes backwards', () => {
    const times = [100, 100, 99, 100, 101]
    const randomSizes: number[] = []
    const random = new Uint8Array(10)
    random[9] = 255
    const source = ulidSource({
      now: () => times.shift() ?? 101,
      random: (size) => {
        randomSizes.push(size)
        return random
      },
    })

    expect(Array.from({ length: 5 }, () => source.next())).toEqual([
      encodeUlid(100, random),
      encodeUlid(100, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 0)),
      encodeUlid(100, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 1)),
      encodeUlid(100, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 2)),
      encodeUlid(101, random),
    ])
    expect(randomSizes).toEqual([10, 10])
    expect(random[9]).toBe(255)
  })

  it('produces 10,000 strictly increasing unique ULIDs in one millisecond', () => {
    const source = ulidSource({ now: () => 100, random: (size) => new Uint8Array(size) })
    const ids = Array.from({ length: 10_000 }, () => source.next())

    expect(ids.every((id, index) => id > (ids[index - 1] ?? ''))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('throws on random overflow and resumes when the clock advances', () => {
    let time = 100
    const random = new Uint8Array(10).fill(255)
    const source = ulidSource({ now: () => time, random: () => random })

    expect(source.next()).toBe(encodeUlid(time, random))
    expect(() => source.next()).toThrow(RangeError)
    expect(() => source.next()).toThrow(RangeError)
    time++
    expect(source.next()).toBe(encodeUlid(time, random))
  })

  it('generates a valid ULID using the default clock and randomness', () => {
    expect(ulidSource().next()).toMatch(new RegExp(`^${ULID_SOURCE}$`))
  })
})

describe('sequenceSource', () => {
  it('starts at the same fixed timestamp and counter for the same options', () => {
    const left = sequenceSource({ time: 123, start: 31 })
    const right = sequenceSource({ time: 123, start: 31 })
    const ids = Array.from({ length: 3 }, () => left.next())

    expect(ids).toEqual(Array.from({ length: 3 }, () => right.next()))
    expect(ids[0]).toBe(encodeUlid(123, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 31)))
    expect(ids[1]).toBe(encodeUlid(123, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 32)))
    expect(sequenceSource().next()).toBe('0'.repeat(25) + '1')
  })

  it('increments exactly from a large representable counter', () => {
    const source = sequenceSource({ start: 2 ** 79 })
    expect(source.next()).toBe('0'.repeat(10) + 'G' + '0'.repeat(15))
    expect(source.next()).toBe('0'.repeat(10) + 'G' + '0'.repeat(14) + '1')
  })

  it('rejects sequence starts outside the 80-bit integer range', () => {
    for (const start of [-1, 0.5, 2 ** 80, NaN, Infinity]) {
      expect(() => sequenceSource({ start })).toThrow(RangeError)
    }
  })

  it('formats node and page ids with their prefixes', () => {
    const source = sequenceSource()

    expect(newId('n', source)).toMatch(new RegExp(`^n_${ULID_SOURCE}$`))
    expect(newId('pg', source)).toBe('pg_' + '0'.repeat(25) + '2')
  })
})
