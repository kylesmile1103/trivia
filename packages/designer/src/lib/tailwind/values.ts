// CSS value helpers shared by the converter and the parser: lengths, numbers, and Tailwind's
// arbitrary-value encoding (`p-[13px]`, `w-[calc(100%_-_2rem)]`).

import { ROOT_FONT_SIZE_PX } from './theme'

export interface Length {
  value: number
  unit: 'px' | 'rem'
}

const LENGTH = /^(-?(?:\d+(?:\.\d*)?|\.\d+))(px|rem)?$/

/** `12px`, `1.5rem`, `-0.5rem`, `.5rem`, `0` → number + unit. Unitless only for zero. */
export function parseLength(value: string): Length | null {
  const m = LENGTH.exec(value.trim().toLowerCase())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const unit = m[2] as Length['unit'] | undefined
  if (unit === undefined) return n === 0 ? { value: 0, unit: 'px' } : null
  return { value: n, unit }
}

export function lengthToPx(length: Length): number {
  return length.unit === 'rem' ? length.value * ROOT_FONT_SIZE_PX : length.value
}

/** px value of a px/rem length string, or null for anything else (auto, %, calc(), var()). */
export function cssToPx(value: string): number | null {
  const length = parseLength(value)
  return length ? lengthToPx(length) : null
}

/** Shortest decimal for a scale step or length: 0.5, 1.25, 13 — never `0.30000000000000004`. */
export function formatNumber(n: number): string {
  const rounded = Number(n.toFixed(4))
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

/** True when `n` is an integer within float noise. */
export function isWhole(n: number): boolean {
  return Math.abs(n - Math.round(n)) < 1e-6
}

/** `1.5` → `1.5rem` (Tailwind writes spacing in rem). */
export function remString(px: number): string {
  return `${formatNumber(px / ROOT_FONT_SIZE_PX)}rem`
}

// Characters allowed inside an arbitrary value we write. Deliberately conservative: anything
// else (quotes, braces, semicolons, backslashes) could break out of the class token, the CSS
// rule or the JSX string attribute, so it is refused rather than escaped.
const SAFE_ARBITRARY = /^[\w.%#(),+\-*/ ]+$/

/**
 * Encode a CSS value as a Tailwind arbitrary value: `13px` → `[13px]`,
 * `calc(100% - 2rem)` → `[calc(100%_-_2rem)]`. Returns null when the value is unsafe.
 */
export function encodeArbitrary(value: string): string | null {
  const v = value.trim()
  if (v === '' || !SAFE_ARBITRARY.test(v) || v.includes('_') || !balancedParens(v)) return null
  return `[${v.replace(/\s+/g, '_')}]`
}

/**
 * Decode an arbitrary value or a v4 variable shorthand back to CSS:
 * `[13px]` → `13px`, `[length:var(--x)]` → `var(--x)`, `(--gutter)` → `var(--gutter)`.
 * Returns null when `raw` is neither.
 */
export function decodeArbitrary(raw: string): string | null {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = stripTypeHint(raw.slice(1, -1))
    return inner === '' ? null : inner.replace(/(?<!\\)_/g, ' ').replace(/\\_/g, '_')
  }
  if (raw.startsWith('(') && raw.endsWith(')')) {
    const inner = stripTypeHint(raw.slice(1, -1))
    return inner.startsWith('--') ? `var(${inner})` : null
  }
  return null
}

/** The data-type hint of an arbitrary value (`length` in `[length:var(--x)]`), if any. */
export function arbitraryTypeHint(raw: string): string | null {
  const m = /^[[(]([a-z-]+):/.exec(raw)
  return m?.[1] ?? null
}

function stripTypeHint(inner: string): string {
  return inner.replace(/^[a-z-]+:(?!\/)/, '')
}

function balancedParens(v: string): boolean {
  let depth = 0
  for (const ch of v) {
    if (ch === '(') depth++
    else if (ch === ')' && --depth < 0) return false
  }
  return depth === 0
}

/** Split a CSS value on top-level whitespace: `1rem calc(2px + 1rem)` → two parts. */
export function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value.trim()) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  return parts
}
