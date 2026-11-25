export const ORDER_DIGITS: string = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

const INTEGER_HEADS = ORDER_DIGITS.slice(10)
const LETTERS_PER_CASE = INTEGER_HEADS.length / 2
const MIN_INTEGER = 'A' + '0'.repeat(26)

function integerLength(key: string): number {
  const head = INTEGER_HEADS.indexOf(key.charAt(0))
  return head < LETTERS_PER_CASE ? LETTERS_PER_CASE + 1 - head : head - LETTERS_PER_CASE + 2
}

export function isOrderKey(key: string): boolean {
  if (!/^[A-Za-z][0-9A-Za-z]+$/.test(key) || key === MIN_INTEGER) return false
  const length = integerLength(key)
  return key.length === length || (key.length > length && !key.endsWith('0'))
}

function shiftInteger(integer: string, step: 1 | -1): string | null {
  const fill = step === 1 ? '0' : 'z'
  for (let position = integer.length - 1; position > 0; position--) {
    const digit = ORDER_DIGITS.indexOf(integer.charAt(position)) + step
    if (digit >= 0 && digit < ORDER_DIGITS.length) {
      return integer.slice(0, position) + ORDER_DIGITS.charAt(digit) + fill.repeat(integer.length - position - 1)
    }
  }

  const head = INTEGER_HEADS.charAt(INTEGER_HEADS.indexOf(integer.charAt(0)) + step)
  return head === '' ? null : head + fill.repeat(integerLength(head) - 1)
}

function fractionBetween(a: string, b: string | null): string {
  let prefix = ''
  for (let position = 0; ; position++) {
    const lower = position < a.length ? ORDER_DIGITS.indexOf(a.charAt(position)) : 0
    const upper = b === null ? ORDER_DIGITS.length : ORDER_DIGITS.indexOf(b.charAt(position))
    if (upper - lower > 1) {
      return prefix + ORDER_DIGITS.charAt(Math.round((lower + upper) / 2))
    }
    if (upper > lower) {
      if (b !== null && position + 1 < b.length) return prefix + b.charAt(position)
      // An adjacent upper digit leaves room to extend only the lower prefix.
      b = null
    }
    prefix += ORDER_DIGITS.charAt(lower)
  }
}

export function keyBetween(a: string | null, b: string | null): string {
  if ((a !== null && !isOrderKey(a)) || (b !== null && !isOrderKey(b))) {
    throw new RangeError('Invalid order key')
  }

  if (a === null) {
    if (b === null) return 'a0'
    const integer = b.slice(0, integerLength(b))
    if (integer === MIN_INTEGER) return integer + fractionBetween('', b.slice(integer.length))
    if (integer < b) return integer
    const previous = shiftInteger(integer, -1)
    if (previous !== null && previous !== MIN_INTEGER) return previous
    // The reserved minimum needs a fraction to serve as a key.
    return MIN_INTEGER + fractionBetween('', null)
  }

  if (b !== null && a >= b) throw new RangeError('Order keys must be strictly increasing')
  const integer = a.slice(0, integerLength(a))
  const fraction = a.slice(integer.length)
  if (b !== null && integer === b.slice(0, integerLength(b))) {
    return integer + fractionBetween(fraction, b.slice(integer.length))
  }

  const next = shiftInteger(integer, 1)
  if (next !== null && (b === null || next < b)) return next
  return integer + fractionBetween(fraction, null)
}

export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (!Number.isInteger(n) || n < 0 || n > 2 ** 32 - 1) {
    throw new RangeError('Order key count must be a valid array length')
  }
  if (n === 0) return []

  const keys: string[] = []
  if (b === null) {
    while (keys.length < n) {
      a = keyBetween(a, null)
      keys.push(a)
    }
  } else if (a === null) {
    while (keys.length < n) {
      b = keyBetween(null, b)
      keys.push(b)
    }
    keys.reverse()
  } else {
    const add = (lower: string, upper: string, count: number): void => {
      if (count === 0) return
      const leftCount = Math.floor(count / 2)
      const middle = keyBetween(lower, upper)
      add(lower, middle, leftCount)
      keys.push(middle)
      add(middle, upper, count - leftCount - 1)
    }
    add(a, b, n)
  }
  return keys
}
