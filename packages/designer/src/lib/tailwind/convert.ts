// CSS declaration → Tailwind v4 utility classes, for the properties the style panel edits.
// Colors are out of scope. Invalid or unsupported input throws `TailwindConversionError`:
// writing a guessed class into the user's source would be worse than refusing.
//
// Spacing follows Tailwind v4's scale: one unit is `--spacing` (0.25rem = 4px), so
// 16px = 1rem → `p-4`. Half steps are written bare (`p-0.5`, `p-1.5`); anything off the
// half-step grid or beyond `spacingMax` becomes an arbitrary value in the unit it was given
// (`p-[13px]`, `p-[25rem]`).

import { DEFAULT_THEME, FONT_WEIGHTS, type FontWeightName, type TailwindTheme } from './theme'
import { cssToPx, encodeArbitrary, formatNumber, isWhole, lengthToPx, parseLength, splitTopLevel } from './values'

export type SpacingProperty =
  | 'padding'
  | 'padding-top'
  | 'padding-right'
  | 'padding-bottom'
  | 'padding-left'
  | 'padding-inline'
  | 'padding-block'
  | 'margin'
  | 'margin-top'
  | 'margin-right'
  | 'margin-bottom'
  | 'margin-left'
  | 'margin-inline'
  | 'margin-block'
  | 'gap'
  | 'row-gap'
  | 'column-gap'

export type StyleProperty =
  | SpacingProperty
  | 'display'
  | 'flex-direction'
  | 'flex-wrap'
  | 'align-items'
  | 'justify-content'
  | 'width'
  | 'height'
  | 'border-radius'
  | 'font-size'
  | 'font-weight'
  | 'text-align'
  | 'opacity'

export class TailwindConversionError extends Error {
  readonly property: string
  readonly value: string

  constructor(property: string, value: string, reason: string) {
    super(`cannot write ${property}: ${JSON.stringify(value)} as Tailwind: ${reason}`)
    this.name = 'TailwindConversionError'
    this.property = property
    this.value = value
  }
}

// Single-value spacing properties → utility prefix.
const SPACING_PREFIX = {
  'padding-top': 'pt',
  'padding-right': 'pr',
  'padding-bottom': 'pb',
  'padding-left': 'pl',
  'padding-inline': 'px',
  'padding-block': 'py',
  'margin-top': 'mt',
  'margin-right': 'mr',
  'margin-bottom': 'mb',
  'margin-left': 'ml',
  'margin-inline': 'mx',
  'margin-block': 'my',
  'row-gap': 'gap-y',
  'column-gap': 'gap-x',
} as const satisfies Partial<Record<SpacingProperty, string>>

const DISPLAY: Record<string, string> = {
  block: 'block',
  'inline-block': 'inline-block',
  inline: 'inline',
  flex: 'flex',
  'inline-flex': 'inline-flex',
  grid: 'grid',
  'inline-grid': 'inline-grid',
  contents: 'contents',
  'flow-root': 'flow-root',
  table: 'table',
  none: 'hidden',
}

const FLEX_DIRECTION: Record<string, string> = {
  row: 'flex-row',
  'row-reverse': 'flex-row-reverse',
  column: 'flex-col',
  'column-reverse': 'flex-col-reverse',
}

const FLEX_WRAP: Record<string, string> = {
  wrap: 'flex-wrap',
  nowrap: 'flex-nowrap',
  'wrap-reverse': 'flex-wrap-reverse',
}

const ALIGN_ITEMS: Record<string, string> = {
  'flex-start': 'items-start',
  start: 'items-start',
  'flex-end': 'items-end',
  end: 'items-end',
  center: 'items-center',
  baseline: 'items-baseline',
  stretch: 'items-stretch',
}

const JUSTIFY_CONTENT: Record<string, string> = {
  'flex-start': 'justify-start',
  start: 'justify-start',
  'flex-end': 'justify-end',
  end: 'justify-end',
  center: 'justify-center',
  'space-between': 'justify-between',
  'space-around': 'justify-around',
  'space-evenly': 'justify-evenly',
  stretch: 'justify-stretch',
  normal: 'justify-normal',
}

const TEXT_ALIGN: Record<string, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
  justify: 'text-justify',
  start: 'text-start',
  end: 'text-end',
}

const SIZE_KEYWORDS: Record<string, string> = {
  auto: 'auto',
  '100%': 'full',
  'fit-content': 'fit',
  'min-content': 'min',
  'max-content': 'max',
}

const VIEWPORT_UNITS = { width: ['vw', 'dvw', 'svw', 'lvw'], height: ['vh', 'dvh', 'svh', 'lvh'] } as const

// Fractions Tailwind users write (w-1/2, w-2/3, w-5/12), in lowest terms, keyed by percentage.
const FRACTIONS: ReadonlyArray<readonly [number, string]> = (() => {
  const out: Array<[number, string]> = []
  const seen = new Set<string>()
  for (const d of [2, 3, 4, 5, 6, 12]) {
    for (let n = 1; n < d; n++) {
      const g = gcd(n, d)
      const key = `${n / g}/${d / g}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push([(n / d) * 100, key])
    }
  }
  return out
})()

/** Convert one CSS declaration to Tailwind classes (space-separated when a shorthand needs several). */
export function cssToTailwind(property: StyleProperty, value: string, theme: TailwindTheme = DEFAULT_THEME): string {
  // Keywords match case-insensitively; arbitrary values keep their case (`var(--myGap)`).
  const v = value.trim()
  const k = v.toLowerCase()
  const fail = (reason: string): never => {
    throw new TailwindConversionError(property, value, reason)
  }
  if (v === '') fail('empty value')

  switch (property) {
    case 'padding':
      return boxShorthand('p', v, NONNEG, theme, fail)
    case 'margin':
      return boxShorthand('m', v, MARGIN, theme, fail)
    case 'gap': {
      const parts = splitTopLevel(v)
      if (parts.length === 1) return spacingClass('gap', v, NONNEG, theme, fail)
      if (parts.length === 2) {
        const [row, column] = parts as [string, string]
        if (row === column) return spacingClass('gap', row, NONNEG, theme, fail)
        return `${spacingClass('gap-y', row, NONNEG, theme, fail)} ${spacingClass('gap-x', column, NONNEG, theme, fail)}`
      }
      return fail('gap takes one or two values')
    }
    case 'padding-top':
    case 'padding-right':
    case 'padding-bottom':
    case 'padding-left':
    case 'padding-inline':
    case 'padding-block':
    case 'row-gap':
    case 'column-gap':
      return spacingClass(SPACING_PREFIX[property], single(v, fail), NONNEG, theme, fail)
    case 'margin-top':
    case 'margin-right':
    case 'margin-bottom':
    case 'margin-left':
    case 'margin-inline':
    case 'margin-block':
      return spacingClass(SPACING_PREFIX[property], single(v, fail), MARGIN, theme, fail)
    case 'width':
    case 'height':
      return sizeClass(property, v, theme, fail)
    case 'display':
      return DISPLAY[k] ?? fail(`unsupported display (supported: ${Object.keys(DISPLAY).join(', ')})`)
    case 'flex-direction':
      return FLEX_DIRECTION[k] ?? fail('expected row, row-reverse, column or column-reverse')
    case 'flex-wrap':
      return FLEX_WRAP[k] ?? fail('expected wrap, nowrap or wrap-reverse')
    case 'align-items':
      return ALIGN_ITEMS[k] ?? fail('expected start, end, center, baseline or stretch')
    case 'justify-content':
      return JUSTIFY_CONTENT[k] ?? fail('expected start, end, center, space-between/around/evenly, stretch or normal')
    case 'text-align':
      return TEXT_ALIGN[k] ?? fail('expected left, center, right, justify, start or end')
    case 'border-radius':
      return radiusClass(v, theme, fail)
    case 'font-size':
      return fontSizeClass(v, theme, fail)
    case 'font-weight':
      return fontWeightClass(v, fail)
    case 'opacity':
      return opacityClass(v, fail)
  }
}

/**
 * Convert a set of declarations (the same record the canvas previews) to classes, in
 * declaration order. Throws on the first declaration that cannot be converted.
 */
export function declarationsToTailwind(style: Readonly<Record<string, string>>, theme: TailwindTheme = DEFAULT_THEME): string[] {
  return Object.entries(style).flatMap(([property, value]) => {
    if (!isStyleProperty(property)) {
      throw new TailwindConversionError(property, value, 'not a property the style panel converts')
    }
    return cssToTailwind(property, value, theme).split(' ')
  })
}

const STYLE_PROPERTIES = new Set<string>([
  'padding',
  'margin',
  'gap',
  ...Object.keys(SPACING_PREFIX),
  'display',
  'flex-direction',
  'flex-wrap',
  'align-items',
  'justify-content',
  'width',
  'height',
  'border-radius',
  'font-size',
  'font-weight',
  'text-align',
  'opacity',
])

export function isStyleProperty(property: string): property is StyleProperty {
  return STYLE_PROPERTIES.has(property)
}

// ---------------------------------------------------------------------------------------------

type Fail = (reason: string) => never

interface SpacingRules {
  negative: boolean
  auto: boolean
}

const NONNEG: SpacingRules = { negative: false, auto: false }
const MARGIN: SpacingRules = { negative: true, auto: true }
const SIZE: SpacingRules = { negative: false, auto: true }

function single(v: string, fail: Fail): string {
  if (splitTopLevel(v).length !== 1) fail('expected a single value')
  return v
}

/** `p` + `1rem 2rem` → `py-4 px-8`; equal sides collapse to the shortest form. */
function boxShorthand(prefix: 'p' | 'm', v: string, rules: SpacingRules, theme: TailwindTheme, fail: Fail): string {
  const parts = splitTopLevel(v)
  if (parts.length < 1 || parts.length > 4) fail('expected one to four values')
  const suffix = (part: string) => spacingSuffix(part, rules, theme, fail)
  const [t, r = t, b = t, l = r] = parts.map(suffix) as [Suffix, Suffix?, Suffix?, Suffix?]
  const cls = (p: string, s: Suffix) => `${s.negative ? '-' : ''}${p}-${s.value}`
  const same = (a: Suffix, c: Suffix) => a.value === c.value && a.negative === c.negative
  if (same(t, r) && same(t, b) && same(t, l)) return cls(prefix, t)
  const out: string[] = []
  if (same(t, b)) out.push(cls(`${prefix}y`, t))
  else out.push(cls(`${prefix}t`, t), cls(`${prefix}b`, b))
  if (same(l, r)) out.push(cls(`${prefix}x`, r))
  else out.push(cls(`${prefix}r`, r), cls(`${prefix}l`, l))
  return out.join(' ')
}

function spacingClass(prefix: string, v: string, rules: SpacingRules, theme: TailwindTheme, fail: Fail): string {
  const s = spacingSuffix(v, rules, theme, fail)
  return `${s.negative ? '-' : ''}${prefix}-${s.value}`
}

interface Suffix {
  value: string
  negative: boolean
}

/** One spacing value → class suffix: `1.5rem` → `6`, `1px` → `px`, `13px` → `[13px]`, `-0.5rem` → negative `2`. */
function spacingSuffix(v: string, rules: SpacingRules, theme: TailwindTheme, fail: Fail): Suffix {
  if (v.toLowerCase() === 'auto') {
    if (!rules.auto) fail('auto is not valid here')
    return { value: 'auto', negative: false }
  }
  const length = parseLength(v)
  if (length) {
    const negative = length.value < 0
    if (negative && !rules.negative) fail('cannot be negative')
    const magnitude = { value: Math.abs(length.value), unit: length.unit }
    const px = lengthToPx(magnitude)
    if (px === 0) return { value: '0', negative: false }
    if (px === 1) return { value: 'px', negative }
    const steps = px / theme.spacingPx
    if (isWhole(steps * 2) && steps <= theme.spacingMax) return { value: formatNumber(steps), negative }
    return { value: `[${formatNumber(magnitude.value)}${magnitude.unit}]`, negative }
  }
  rejectUnitless(v, fail)
  if (v.startsWith('-')) fail('negative values must be px or rem lengths')
  // Other units and functions (%, em, vh, calc(), var()) are written exactly.
  return { value: arbitraryLength(v, fail), negative: false }
}

function sizeClass(property: 'width' | 'height', v: string, theme: TailwindTheme, fail: Fail): string {
  const prefix = property === 'width' ? 'w' : 'h'
  const k = v.toLowerCase()
  const keyword = SIZE_KEYWORDS[k]
  if (keyword) return `${prefix}-${keyword}`
  for (const unit of VIEWPORT_UNITS[property]) {
    if (k === `100${unit}`) return `${prefix}-${unit === 'vw' || unit === 'vh' ? 'screen' : unit}`
  }
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(v)
  if (percent) {
    const p = Number(percent[1])
    const fraction = FRACTIONS.find(([pct]) => Math.abs(pct - p) < 0.001)
    if (fraction) return `${prefix}-${fraction[1]}`
  }
  return spacingClass(prefix, v, SIZE, theme, fail)
}

function radiusClass(v: string, theme: TailwindTheme, fail: Fail): string {
  const k = v.toLowerCase().replace(/\s+/g, ' ')
  if (k === 'calc(infinity * 1px)' || k === '9999px') return 'rounded-full'
  const px = cssToPx(v)
  if (px !== null) {
    if (px < 0) fail('cannot be negative')
    if (px === 0) return 'rounded-none'
    const name = namedLength(theme.radius, px)
    if (name !== null) return `rounded-${name}`
    return `rounded-${arbitraryLength(v, fail)}`
  }
  rejectUnitless(v, fail)
  if (v.startsWith('-')) fail('cannot be negative')
  return `rounded-${arbitraryLength(v, fail)}`
}

function fontSizeClass(v: string, theme: TailwindTheme, fail: Fail): string {
  const px = cssToPx(v)
  if (px !== null) {
    if (px <= 0) fail('must be positive')
    const name = namedLength(theme.fontSize, px)
    if (name !== null) return `text-${name}`
  }
  rejectUnitless(v, fail)
  if (v.startsWith('-')) fail('must be positive')
  // `text-[…]` is also the arbitrary *color* utility; Tailwind and tailwind-merge read it as a
  // font size only when the value is plainly a length, so anything else gets the type hint.
  const inner = arbitraryLength(v, fail).slice(1, -1)
  return /^(?:\d|\.|calc\(|clamp\(|min\(|max\()/.test(inner) ? `text-[${inner}]` : `text-[length:${inner}]`
}

function fontWeightClass(v: string, fail: Fail): string {
  const k = v.toLowerCase()
  if (Object.hasOwn(FONT_WEIGHTS, k)) return `font-${k}`
  if (!/^\d+$/.test(v)) return fail('expected a number from 1 to 1000 or a weight name')
  const n = Number(v)
  if (n < 1 || n > 1000) fail('expected a number from 1 to 1000')
  const name = (Object.keys(FONT_WEIGHTS) as FontWeightName[]).find((w) => FONT_WEIGHTS[w] === n)
  return name ? `font-${name}` : `font-[${n}]`
}

function opacityClass(v: string, fail: Fail): string {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(%)?$/.exec(v)
  if (!m) return fail('expected a number from 0 to 1 or a percentage')
  const n = Number(m[1])
  const percent = m[2] ? n : n * 100
  if (percent < 0 || percent > 100) fail('must be between 0 and 1')
  if (isWhole(percent)) return `opacity-${Math.round(percent)}`
  return `opacity-[${formatNumber(percent / 100)}]`
}

function namedLength(scale: Readonly<Record<string, string>>, px: number): string | null {
  for (const [name, css] of Object.entries(scale)) {
    const tokenPx = cssToPx(css)
    if (tokenPx !== null && Math.abs(tokenPx - px) < 1e-6) return name
  }
  return null
}

/** A bare non-zero number is not a CSS length (`padding: 16` is invalid). */
function rejectUnitless(v: string, fail: Fail): void {
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(v)) fail('lengths need a unit (px or rem)')
}

// What an arbitrary length may look like: a number with a CSS unit, or a CSS function.
const CSS_LENGTH =
  /^(?:-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|ex|ch|lh|rlh|%|vw|vh|vmin|vmax|dvw|dvh|svw|svh|lvw|lvh|cqw|cqh|pt|pc|cm|mm|in)|(?:calc|var|clamp|min|max|env)\(.+\))$/i

/** An arbitrary length (`[13px]`, `[calc(100%_-_2rem)]`); words like `sm` are refused. */
function arbitraryLength(v: string, fail: Fail): string {
  if (!CSS_LENGTH.test(v)) fail('expected a CSS length (13px, 1.5rem, 50%, calc(…), var(--x))')
  return encodeArbitrary(v) ?? fail('unsupported characters for an arbitrary value')
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}
