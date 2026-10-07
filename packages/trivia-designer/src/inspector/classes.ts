// className token editing for the class manager. Pure functions, so the merge rules can be
// tested without a browser.
//
// Conflicts are resolved with tailwind-merge (Onlook does the same), but only between what the
// user adds and what is already there: two authored tokens that happen to conflict are the
// user's business, and dropping one would be an unrequested edit. A replacement takes the
// replaced token's slot, so `p-4 justify-end` + `p-6` becomes `p-6 justify-end` and the source
// diff is one token wide.

import { twMerge } from 'tailwind-merge'

/** Split a className string into tokens (any run of whitespace separates). */
export function splitClasses(value: string): string[] {
  return value.split(/\s+/).filter((token) => token.length > 0)
}

/** True when tailwind-merge drops `earlier` in favour of `later` (`p-6` overrides `p-4`). */
export function overrides(later: string, earlier: string): boolean {
  if (later === earlier) return false
  return !splitClasses(twMerge(earlier, later)).includes(earlier)
}

/**
 * Add `added` tokens to `current`. Tokens already present are ignored; among the added tokens a
 * later one beats an earlier conflicting one; an added token that overrides an existing one
 * replaces it in place (several replaced tokens collapse into the first one's slot); the rest
 * are appended in the order given.
 */
export function mergeClasses(current: readonly string[], added: readonly string[]): string[] {
  const fresh = [...new Set(added)].filter((token) => !current.includes(token))
  const effective = fresh.filter((token, i) => !fresh.slice(i + 1).some((later) => overrides(later, token)))

  const result: string[] = []
  const placed = new Set<string>()
  for (const token of current) {
    const replacement = effective.find((candidate) => overrides(candidate, token))
    if (replacement === undefined) {
      result.push(token)
    } else if (!placed.has(replacement)) {
      result.push(replacement)
      placed.add(replacement)
    }
  }
  for (const token of effective) {
    if (!placed.has(token)) result.push(token)
  }
  return result
}

/** `current` without every occurrence of `token`. */
export function removeClass(current: readonly string[], token: string): string[] {
  return current.filter((t) => t !== token)
}

/**
 * The value to write for a token list: the joined tokens, or null (remove the attribute) when
 * none are left — an empty `className=""` is noise in the user's source.
 */
export function classValue(tokens: readonly string[]): string | null {
  return tokens.length > 0 ? tokens.join(' ') : null
}
