// Merge new utilities into a user-authored className with tailwind-merge's conflict rules,
// while touching as little of the string as possible: a replacement takes the place of the
// first token it overrides, other tokens keep their order, and the whitespace between tokens
// (including line breaks in multi-line classNames) is preserved.
//
// Unlike `twMerge(current, additions)`, conflicts *among existing tokens* that no addition
// touches are left as written — cleaning those up would be an unrequested edit.

import { twMerge } from 'tailwind-merge'

import { parseToken, splitClassName, type Utility } from './parse'
import { DEFAULT_THEME, type TailwindTheme } from './theme'

interface Piece {
  /** Whitespace between the previous token and this one ("" for the first). */
  before: string
  token: string
}

interface Tokens {
  leading: string
  pieces: Piece[]
  trailing: string
}

/**
 * `mergeClassName('p-4 flex', 'p-6')` → `'p-6 flex'`;
 * `mergeClassName('px-2 py-4 text-sm', ['p-6'])` → `'p-6 text-sm'`.
 */
export function mergeClassName(current: string, additions: string | readonly string[]): string {
  const adds = typeof additions === 'string' ? splitClassName(additions) : additions.flatMap(splitClassName)
  const tokens = tokenize(current)
  for (const add of adds) mergeOne(tokens, add)
  return join(tokens)
}

function mergeOne({ pieces }: Tokens, add: string): void {
  const overridden = pieces.flatMap((p, i) => (overrides(add, p.token) ? [i] : []))
  const first = overridden[0]
  // In place only if nothing after that slot would override `add` in turn: shadcn components
  // run the className through twMerge again at runtime (`cn(base, className)`), where later
  // tokens win, so the result must keep `add` under that reading too.
  const inPlace =
    first !== undefined && !pieces.some((p, i) => i > first && !overridden.includes(i) && overrides(p.token, add))
  for (const i of overridden.toReversed()) {
    if (inPlace && i === first) pieces[i]!.token = add
    else removeAt(pieces, i)
  }
  if (!inPlace) pieces.push({ before: pieces.length === 0 ? '' : ' ', token: add })
}

/**
 * Remove the base tokens of the given utilities (`removeUtilities('p-4 md:p-2 flex', ['p'])`
 * → `'md:p-2 flex'`). Tokens with variants are never removed.
 */
export function removeUtilities(current: string, utilities: Iterable<Utility>, theme: TailwindTheme = DEFAULT_THEME): string {
  const remove = new Set(utilities)
  const tokens = tokenize(current)
  const { pieces } = tokens
  for (let i = 0; i < pieces.length; ) {
    const parsed = parseToken(pieces[i]!.token, theme)
    if (parsed && remove.has(parsed.utility)) removeAt(pieces, i)
    else i++
  }
  return join(tokens)
}

/** True when `addition` written after `existing` makes `existing` redundant (or equals it). */
function overrides(addition: string, existing: string): boolean {
  return twMerge(existing, addition) === addition
}

function tokenize(className: string): Tokens {
  const pieces: Piece[] = []
  const re = /(\s*)(\S+)/g
  let leading = ''
  let end = 0
  for (let m = re.exec(className); m !== null; m = re.exec(className)) {
    if (pieces.length === 0) leading = m[1] ?? ''
    pieces.push({ before: pieces.length === 0 ? '' : (m[1] ?? ''), token: m[2] ?? '' })
    end = re.lastIndex
  }
  // A whitespace-only className has no layout worth keeping.
  return { leading, pieces, trailing: pieces.length === 0 ? '' : className.slice(end) }
}

function removeAt(pieces: Piece[], i: number): void {
  pieces.splice(i, 1)
  // The new first token loses the separator it had after the removed one.
  if (i === 0 && pieces[0]) pieces[0].before = ''
}

function join({ leading, pieces, trailing }: Tokens): string {
  // An emptied className collapses to "" rather than keeping stray whitespace.
  if (pieces.length === 0) return ''
  return leading + pieces.map((p) => p.before + p.token).join('') + trailing
}
