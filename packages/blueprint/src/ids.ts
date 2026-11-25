export const ULID_ALPHABET: string = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const ULID_SOURCE: string = '[0-7][0-9A-HJKMNP-TV-Z]{25}'

const RANDOM_BITS = 80n
const RANDOM_LIMIT = 1n << RANDOM_BITS

export type IdPrefix = 'pg' | 'n'
export interface IdSource {
  next(): string
}

function timeBits(timeMs: number): bigint {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs >= 2 ** 48) {
    throw new RangeError('ULID time must be an unsigned 48-bit integer')
  }
  return BigInt(timeMs)
}

function randomBits(bytes: Uint8Array): bigint {
  if (bytes.length !== 10) throw new RangeError('ULID randomness must be 10 bytes')
  let bits = 0n
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte)
  return bits
}

function encodeBits(time: bigint, random: bigint): string {
  if (random >= RANDOM_LIMIT) throw new RangeError('ULID random part overflow')
  let bits = (time << RANDOM_BITS) | random
  let ulid = ''
  for (let digit = 0; digit < 26; digit++) {
    ulid = ULID_ALPHABET.charAt(Number(bits & 31n)) + ulid
    bits >>= 5n
  }
  return ulid
}

export function encodeUlid(timeMs: number, random: Uint8Array): string {
  return encodeBits(timeBits(timeMs), randomBits(random))
}

export function ulidSource({
  now = Date.now,
  random = (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
}: { now?: () => number; random?: (bytes: number) => Uint8Array } = {}): IdSource {
  let lastTime = -1n
  let lastRandom = 0n
  return {
    next() {
      const time = timeBits(now())
      const freshTime = time > lastTime
      const nextTime = freshTime ? time : lastTime
      const nextRandom = freshTime ? randomBits(random(10)) : lastRandom + 1n
      const ulid = encodeBits(nextTime, nextRandom)
      lastTime = nextTime
      lastRandom = nextRandom
      return ulid
    },
  }
}

export function sequenceSource({ time = 0, start = 1 }: { time?: number; start?: number } = {}): IdSource {
  const timestamp = timeBits(time)
  if (!Number.isInteger(start) || start < 0 || start >= Number(RANDOM_LIMIT)) {
    throw new RangeError('ULID sequence start must be an unsigned 80-bit integer')
  }
  let counter = BigInt(start)
  return {
    next() {
      const ulid = encodeBits(timestamp, counter)
      counter++
      return ulid
    },
  }
}

export function newId(prefix: IdPrefix, source: IdSource): string {
  return `${prefix}_${source.next()}`
}
