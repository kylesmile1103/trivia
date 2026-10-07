// className → structured style state for the panel's controls (the inverse of convert.ts).
//
// Only base utilities are modelled. Tokens with a variant (`md:p-4`, `hover:opacity-50`), an
// important marker (`p-4!`, `!p-4`) or a utility the panel does not edit end up in `other`
// untouched; mergeClassName keeps them as written.

import { CONTAINER_SIZES, DEFAULT_THEME, FONT_WEIGHTS, type TailwindTheme } from './theme'
import { arbitraryTypeHint, cssToPx, decodeArbitrary, formatNumber, isWhole, remString } from './values'

export type SpacingUtility =
  | 'p'
  | 'px'
  | 'py'
  | 'pt'
  | 'pr'
  | 'pb'
  | 'pl'
  | 'm'
  | 'mx'
  | 'my'
  | 'mt'
  | 'mr'
  | 'mb'
  | 'ml'
  | 'gap'
  | 'gap-x'
  | 'gap-y'

export type Utility =
  | SpacingUtility
  | 'w'
  | 'h'
  | 'size'
  | 'display'
  | 'flex-direction'
  | 'flex-wrap'
  | 'align-items'
  | 'justify-content'
  | 'rounded'
  | 'font-size'
  | 'font-weight'
  | 'text-align'
  | 'opacity'

export interface ParsedToken {
  /** The class as written. */
  token: string
  utility: Utility
  /**
   * The CSS value it sets (`1rem`, `13px`, `auto`, `none`, `space-between`, `0.5`), or null
   * when that depends on a theme value we were not given (`rounded-lg` under SCALE_ONLY_THEME).
   */
  css: string | null
  /** px for px/rem lengths (`p-4` → 16), else null. Negative for negative margins. */
  px: number | null
  /** Bare spacing multiplier (`p-4` → 4, `-m-2` → -2), else null. */
  scale: number | null
  /** Named token (`rounded-lg` → `lg`, `text-sm` → `sm`, `w-full` → `full`), else null. */
  name: string | null
}

export type Side = 'top' | 'right' | 'bottom' | 'left'
export type Box = Record<Side, ParsedToken | null>
/** How a box property is written: `p-4` (all), `px-2 py-4` (axis) or `pt-1 …` (sides). */
export type BoxMode = 'all' | 'axis' | 'sides'

export interface StyleState {
  padding: Box
  paddingMode: BoxMode
  margin: Box
  marginMode: BoxMode
  /** `row` is row-gap (`gap-y`), `column` is column-gap (`gap-x`). */
  gap: { row: ParsedToken | null; column: ParsedToken | null }
  gapMode: 'all' | 'axis'
  width: ParsedToken | null
  height: ParsedToken | null
  display: ParsedToken | null
  flexDirection: ParsedToken | null
  flexWrap: ParsedToken | null
  alignItems: ParsedToken | null
  justifyContent: ParsedToken | null
  radius: ParsedToken | null
  fontSize: ParsedToken | null
  fontWeight: ParsedToken | null
  textAlign: ParsedToken | null
  opacity: ParsedToken | null
  /** Tokens no control models, in order, as written. */
  other: string[]
}

// Keyword utilities: class → [utility, CSS value].
const KEYWORDS: Record<string, readonly [Utility, string]> = {
  block: ['display', 'block'],
  'inline-block': ['display', 'inline-block'],
  inline: ['display', 'inline'],
  flex: ['display', 'flex'],
  'inline-flex': ['display', 'inline-flex'],
  grid: ['display', 'grid'],
  'inline-grid': ['display', 'inline-grid'],
  contents: ['display', 'contents'],
  'flow-root': ['display', 'flow-root'],
  table: ['display', 'table'],
  hidden: ['display', 'none'],
  'flex-row': ['flex-direction', 'row'],
  'flex-row-reverse': ['flex-direction', 'row-reverse'],
  'flex-col': ['flex-direction', 'column'],
  'flex-col-reverse': ['flex-direction', 'column-reverse'],
  'flex-wrap': ['flex-wrap', 'wrap'],
  'flex-wrap-reverse': ['flex-wrap', 'wrap-reverse'],
  'flex-nowrap': ['flex-wrap', 'nowrap'],
  'items-start': ['align-items', 'flex-start'],
  'items-end': ['align-items', 'flex-end'],
  'items-center': ['align-items', 'center'],
  'items-baseline': ['align-items', 'baseline'],
  'items-stretch': ['align-items', 'stretch'],
  'justify-start': ['justify-content', 'flex-start'],
  'justify-end': ['justify-content', 'flex-end'],
  'justify-center': ['justify-content', 'center'],
  'justify-between': ['justify-content', 'space-between'],
  'justify-around': ['justify-content', 'space-around'],
  'justify-evenly': ['justify-content', 'space-evenly'],
  'justify-stretch': ['justify-content', 'stretch'],
  'justify-normal': ['justify-content', 'normal'],
  'text-left': ['text-align', 'left'],
  'text-center': ['text-align', 'center'],
  'text-right': ['text-align', 'right'],
  'text-justify': ['text-align', 'justify'],
  'text-start': ['text-align', 'start'],
  'text-end': ['text-align', 'end'],
}

const SIZE_KEYWORDS: Record<string, string> = {
  auto: 'auto',
  full: '100%',
  fit: 'fit-content',
  min: 'min-content',
  max: 'max-content',
  dvw: '100dvw',
  svw: '100svw',
  lvw: '100lvw',
  dvh: '100dvh',
  svh: '100svh',
  lvh: '100lvh',
}

// Radius and font-size names Tailwind v4 defines; recognised even when the theme passed in
// does not give their values (the token is then reported with `css: null`).
const RADIUS_NAMES = new Set(Object.keys(DEFAULT_THEME.radius))
const FONT_SIZE_NAMES = new Set(Object.keys(DEFAULT_THEME.fontSize))
const CONTAINERS = new Set<string>(CONTAINER_SIZES)

const SPACING = /^(-?)(p[xytrbl]?|m[xytrbl]?)-(.+)$/
const GAP = /^gap(?:-([xy]))?-(.+)$/
const SIZE = /^(w|h|size)-(.+)$/

/** Classify one class token, or null when no control models it. */
export function parseToken(token: string, theme: TailwindTheme = DEFAULT_THEME): ParsedToken | null {
  if (token === '' || hasVariant(token) || token.startsWith('!') || token.endsWith('!')) return null

  const keyword = KEYWORDS[token]
  if (keyword) return make(token, keyword[0], keyword[1], { name: token })

  let m = SPACING.exec(token)
  if (m) {
    const [, minus = '', utility = '', raw = ''] = m
    const isMargin = utility.startsWith('m')
    if (minus && !isMargin) return null
    const value = spacingValue(raw, { auto: isMargin && !minus }, theme)
    return value ? make(token, utility as SpacingUtility, ...signed(value, minus === '-')) : null
  }

  m = GAP.exec(token)
  if (m) {
    const [, axis, raw = ''] = m
    const value = spacingValue(raw, { auto: false }, theme)
    return value ? make(token, axis ? (`gap-${axis}` as SpacingUtility) : 'gap', value.css, value) : null
  }

  m = SIZE.exec(token)
  if (m) {
    const [, utility = '', raw = ''] = m
    const value = sizeValue(utility as 'w' | 'h' | 'size', raw, theme)
    return value ? make(token, utility as 'w' | 'h' | 'size', value.css, value) : null
  }

  if (token === 'rounded') return make(token, 'rounded', '0.25rem', { name: '' })
  if (token.startsWith('rounded-')) return radiusToken(token, token.slice('rounded-'.length), theme)
  if (token.startsWith('text-')) return fontSizeToken(token, token.slice('text-'.length), theme)
  if (token.startsWith('font-')) return fontWeightToken(token, token.slice('font-'.length))
  if (token.startsWith('opacity-')) return opacityToken(token, token.slice('opacity-'.length))
  return null
}

/** Parse a className into the state the controls show. Later tokens win within a level. */
export function parse(className: string, theme: TailwindTheme = DEFAULT_THEME): StyleState {
  const state: StyleState = {
    padding: emptyBox(),
    paddingMode: 'all',
    margin: emptyBox(),
    marginMode: 'all',
    gap: { row: null, column: null },
    gapMode: 'all',
    width: null,
    height: null,
    display: null,
    flexDirection: null,
    flexWrap: null,
    alignItems: null,
    justifyContent: null,
    radius: null,
    fontSize: null,
    fontWeight: null,
    textAlign: null,
    opacity: null,
    other: [],
  }
  // CSS precedence in Tailwind v4's output: shorthands sort before longhands (p < px/py <
  // pt/pr/pb/pl; size < w/h; gap < gap-x/gap-y), whatever the className order.
  const parsed: ParsedToken[] = []
  for (const token of splitClassName(className)) {
    const p = parseToken(token, theme)
    if (p) parsed.push(p)
    else state.other.push(token)
  }
  for (const level of [0, 1, 2] as const) {
    for (const p of parsed) {
      if (BOX_LEVEL[p.utility] !== level) continue
      const target = p.utility.startsWith('p') ? state.padding : state.margin
      for (const side of BOX_SIDES[p.utility] ?? []) target[side] = p
    }
  }
  for (const p of parsed) {
    switch (p.utility) {
      case 'gap':
        state.gap = { row: p, column: p }
        break
      case 'size':
        state.width = p
        state.height = p
        break
    }
  }
  for (const p of parsed) {
    switch (p.utility) {
      case 'gap-x':
        state.gap.column = p
        break
      case 'gap-y':
        state.gap.row = p
        break
      case 'w':
        state.width = p
        break
      case 'h':
        state.height = p
        break
      case 'display':
        state.display = p
        break
      case 'flex-direction':
        state.flexDirection = p
        break
      case 'flex-wrap':
        state.flexWrap = p
        break
      case 'align-items':
        state.alignItems = p
        break
      case 'justify-content':
        state.justifyContent = p
        break
      case 'rounded':
        state.radius = p
        break
      case 'font-size':
        state.fontSize = p
        break
      case 'font-weight':
        state.fontWeight = p
        break
      case 'text-align':
        state.textAlign = p
        break
      case 'opacity':
        state.opacity = p
        break
    }
  }
  state.paddingMode = boxMode(parsed, 'p')
  state.marginMode = boxMode(parsed, 'm')
  state.gapMode = parsed.some((p) => p.utility === 'gap-x' || p.utility === 'gap-y') ? 'axis' : 'all'
  return state
}

export type Common = { kind: 'unset' } | { kind: 'mixed' } | { kind: 'value'; token: ParsedToken }

/** The value shared by several sides (`top`+`bottom` for Y), "mixed", or "unset". */
export function common(values: ReadonlyArray<ParsedToken | null>): Common {
  const first = values[0] ?? null
  const key = (p: ParsedToken | null) => (p === null ? null : (p.css ?? p.token))
  if (values.some((v) => key(v) !== key(first))) return { kind: 'mixed' }
  return first === null ? { kind: 'unset' } : { kind: 'value', token: first }
}

/** Whitespace-separated class tokens (no empties). */
export function splitClassName(className: string): string[] {
  return className.split(/\s+/).filter(Boolean)
}

// ---------------------------------------------------------------------------------------------

const BOX_LEVEL: Partial<Record<Utility, 0 | 1 | 2>> = {
  p: 0,
  px: 1,
  py: 1,
  pt: 2,
  pr: 2,
  pb: 2,
  pl: 2,
  m: 0,
  mx: 1,
  my: 1,
  mt: 2,
  mr: 2,
  mb: 2,
  ml: 2,
}

const BOX_SIDES: Partial<Record<Utility, readonly Side[]>> = {
  p: ['top', 'right', 'bottom', 'left'],
  px: ['left', 'right'],
  py: ['top', 'bottom'],
  pt: ['top'],
  pr: ['right'],
  pb: ['bottom'],
  pl: ['left'],
  m: ['top', 'right', 'bottom', 'left'],
  mx: ['left', 'right'],
  my: ['top', 'bottom'],
  mt: ['top'],
  mr: ['right'],
  mb: ['bottom'],
  ml: ['left'],
}

function boxMode(parsed: readonly ParsedToken[], prefix: 'p' | 'm'): BoxMode {
  const levels = parsed.filter((p) => p.utility.startsWith(prefix) && BOX_LEVEL[p.utility] !== undefined).map((p) => BOX_LEVEL[p.utility])
  if (levels.includes(2)) return 'sides'
  if (levels.includes(1)) return 'axis'
  return 'all'
}

function emptyBox(): Box {
  return { top: null, right: null, bottom: null, left: null }
}

interface Value {
  css: string | null
  px: number | null
  scale: number | null
  name: string | null
}

function make(token: string, utility: Utility, css: string | null, extra: Partial<Value> = {}): ParsedToken {
  return { token, utility, css, px: extra.px ?? null, scale: extra.scale ?? null, name: extra.name ?? null }
}

/** `4` → 1rem (scale 4), `0.5`, `px`, `auto`, `[13px]`, `(--gap)`. */
function spacingValue(raw: string, opts: { auto: boolean }, theme: TailwindTheme): Value | null {
  if (raw === 'px') return { css: '1px', px: 1, scale: null, name: 'px' }
  if (raw === 'auto') return opts.auto ? { css: 'auto', px: null, scale: null, name: 'auto' } : null
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw)
    // Tailwind v4 generates bare multipliers in steps of 0.25 only (`p-3.3` is not a class).
    if (!isWhole(n * 4)) return null
    const px = n * theme.spacingPx
    return { css: n === 0 ? '0px' : remString(px), px, scale: n, name: null }
  }
  const css = decodeArbitrary(raw)
  if (css === null) return null
  return { css, px: cssToPx(css), scale: null, name: null }
}

function signed(value: Value, negative: boolean): [string | null, Partial<Value>] {
  if (!negative) return [value.css, value]
  const css = value.css === null ? null : value.px !== null ? negateLength(value.css) : `calc(${value.css} * -1)`
  return [css, { ...value, px: value.px === null ? null : -value.px, scale: value.scale === null ? null : -value.scale }]
}

function negateLength(css: string): string {
  return css === '0px' ? css : css.startsWith('-') ? css.slice(1) : `-${css}`
}

function sizeValue(utility: 'w' | 'h' | 'size', raw: string, theme: TailwindTheme): Value | null {
  if (raw === 'screen' && utility !== 'size') {
    return { css: utility === 'w' ? '100vw' : '100vh', px: null, scale: null, name: 'screen' }
  }
  const keyword = SIZE_KEYWORDS[raw]
  if (keyword) return { css: keyword, px: null, scale: null, name: raw }
  const fraction = /^(\d+)\/(\d+)$/.exec(raw)
  if (fraction) {
    const pct = (Number(fraction[1]) / Number(fraction[2])) * 100
    return Number.isFinite(pct) ? { css: `${formatNumber(pct)}%`, px: null, scale: null, name: raw } : null
  }
  if (utility === 'w' && CONTAINERS.has(raw)) {
    return { css: `var(--container-${raw})`, px: null, scale: null, name: raw }
  }
  return spacingValue(raw, { auto: true }, theme)
}

function radiusToken(token: string, raw: string, theme: TailwindTheme): ParsedToken | null {
  if (raw === 'none') return make(token, 'rounded', '0px', { px: 0, name: 'none' })
  if (raw === 'full') return make(token, 'rounded', 'calc(infinity * 1px)', { name: 'full' })
  if (RADIUS_NAMES.has(raw) || Object.hasOwn(theme.radius, raw)) {
    const css = theme.radius[raw] ?? null
    return make(token, 'rounded', css, { name: raw, px: css === null ? null : cssToPx(css) })
  }
  const css = decodeArbitrary(raw)
  return css === null ? null : make(token, 'rounded', css, { px: cssToPx(css) })
}

function fontSizeToken(token: string, raw: string, theme: TailwindTheme): ParsedToken | null {
  // `text-sm/6` carries a line-height modifier; the size is still `sm`.
  const name = raw.split('/', 1)[0] ?? raw
  if (FONT_SIZE_NAMES.has(name) || Object.hasOwn(theme.fontSize, name)) {
    const css = theme.fontSize[name] ?? null
    return make(token, 'font-size', css, { name, px: css === null ? null : cssToPx(css) })
  }
  const hint = arbitraryTypeHint(raw)
  const css = decodeArbitrary(raw)
  if (css === null) return null
  // `text-[…]` is a color unless the value is a length (or says so).
  const isLength = hint === 'length' || (hint === null && /^(?:\d|\.|calc\(|clamp\(|min\(|max\()/.test(css))
  return isLength ? make(token, 'font-size', css, { px: cssToPx(css) }) : null
}

function fontWeightToken(token: string, raw: string): ParsedToken | null {
  if (Object.hasOwn(FONT_WEIGHTS, raw)) {
    return make(token, 'font-weight', String(FONT_WEIGHTS[raw as keyof typeof FONT_WEIGHTS]), { name: raw })
  }
  const css = decodeArbitrary(raw)
  return css !== null && /^\d+$/.test(css) ? make(token, 'font-weight', css) : null
}

function opacityToken(token: string, raw: string): ParsedToken | null {
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw)
    return n <= 100 ? make(token, 'opacity', formatNumber(n / 100)) : null
  }
  const css = decodeArbitrary(raw)
  return css === null ? null : make(token, 'opacity', css)
}

/** A `:` outside brackets/parens means a variant (`md:p-4`, `[&>*]:p-2`). */
function hasVariant(token: string): boolean {
  let depth = 0
  for (const ch of token) {
    if (ch === '[' || ch === '(') depth++
    else if (ch === ']' || ch === ')') depth--
    else if (ch === ':' && depth === 0) return true
  }
  return false
}
