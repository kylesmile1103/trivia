// A field's contract bounds in a few words, for the Data tab's add menu.

import type { FieldConstraints } from '@/shared/engine/types'

/** A field's contract bounds in a few words ("2–120 characters, matches /^[A-Z]+$/"), for a tooltip. */
export function boundsText(c: FieldConstraints | null | undefined): string | undefined {
  if (!c) return undefined
  const parts: string[] = []
  if (c.minLength !== undefined && c.maxLength !== undefined) parts.push(`${c.minLength}–${c.maxLength} characters`)
  else if (c.minLength !== undefined) parts.push(`at least ${c.minLength} characters`)
  else if (c.maxLength !== undefined) parts.push(`at most ${c.maxLength} characters`)
  if (c.minimum !== undefined) parts.push(`≥ ${c.minimum}`)
  if (c.exclusiveMinimum !== undefined) parts.push(`> ${c.exclusiveMinimum}`)
  if (c.maximum !== undefined) parts.push(`≤ ${c.maximum}`)
  if (c.exclusiveMaximum !== undefined) parts.push(`< ${c.exclusiveMaximum}`)
  if (c.pattern !== undefined) parts.push(`matches /${c.pattern}/`)
  return parts.length > 0 ? parts.join(', ') : undefined
}
