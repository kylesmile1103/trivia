// A form field's zod rule against its contract field (docs/product.md, slice 5): which bounds
// differ, and whether the rule lets through what the contract refuses (an optional or nullable
// value for a required or non-null field). Drift reports it, and the `align` field change fixes
// it with chain ops, so the rest of the rule (custom calls, messages) stays as written.

import { type Bound, type FormField, boundMessage, boundsOf } from './fields.js'
import type { ChainCall } from './page.js'

/** Calls a new bound goes before: zod's modifiers and checks that wrap the base type. */
export const MODIFIERS = [
  'optional',
  'nullable',
  'nullish',
  'default',
  'prefault',
  'catch',
  'refine',
  'superRefine',
  'check',
  'transform',
  'pipe',
  'overwrite',
  'describe',
  'meta',
  'brand',
  'readonly',
]

/** One bound the rule and the contract disagree on. */
export interface BoundDiff {
  bound: Bound
  /** The call the rule has for it (`max(100, "…")`), or null when it has none. */
  have: ChainCall | null
}

export interface RuleDiff {
  bounds: BoundDiff[]
  /** The rule is `.optional()` (or `.nullish()`) but the contract requires the field. */
  optional: boolean
  /** The rule is `.nullable()` (or `.nullish()`) but the contract's field is not nullable. */
  nullable: boolean
}

/**
 * How `chain` (a field's zod rule) differs from `field` (its contract field), or null when the
 * rule isn't a zod chain Trivia can judge. ⚑ Only the contract's bounds count: a bound only the
 * form has may be deliberate, and so may a form stricter than the API.
 */
export function ruleDiff(chain: ChainCall[] | null, field: FormField): RuleDiff | null {
  if (!chain || chain.length === 0 || !chain[0]!.name.startsWith('z.')) return null
  const calls = chain.slice(1)
  const named = (name: string) => calls.filter((c) => c.name === name)
  const bounds: BoundDiff[] = []
  for (const bound of boundsOf(field)) {
    const have = named(bound.method)
    // Twice (`.max(3).max(4)`): not one call to compare or edit.
    if (have.length > 1) continue
    const call = have[0] ?? null
    if (call === null) {
      bounds.push({ bound, have: null })
      continue
    }
    const value = call.args[0]?.trim()
    // A pattern written another way (`/^[A-Z]+$/`) can't be compared: no verdict.
    if (bound.key === 'pattern' && !value?.startsWith('new RegExp(')) continue
    if (value !== bound.value) bounds.push({ bound, have: call })
  }
  const has = (name: string) => named(name).length > 0
  return {
    bounds,
    optional: field.required && (has('optional') || has('nullish')),
    nullable: !field.nullable && (has('nullable') || has('nullish')),
  }
}

export const hasDiff = (diff: RuleDiff | null): diff is RuleDiff => diff !== null && (diff.bounds.length > 0 || diff.optional || diff.nullable)

/**
 * The message to write when a bound changes from `from` to `to` (⚑ docs/product.md, slice 5):
 * the old bound replaced by the new one when the message names it exactly once, Trivia's own
 * "Required." (a minimum of 1) rewritten, or null to leave the message as written.
 */
export function updatedMessage(source: string | undefined, bound: Bound, from: string | undefined): string | null {
  if (source === undefined || from === undefined) return null
  const literal = /^(["'])(?:(?!\1)[^\\]|\\.)*\1$/s.test(source) || /^`[^`$]*`$/.test(source)
  if (!literal) return null
  if (bound.key === 'minLength' && from === '1' && source.slice(1, -1) === boundMessage('minLength', 1)) {
    return JSON.stringify(bound.message)
  }
  const token = new RegExp(`(?<![\\d.])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d.])`, 'g')
  const hits = source.match(token)
  return hits?.length === 1 ? source.replace(token, bound.value) : null
}

/** A few words for a bound: `min length 2`, `max 10000`, `pattern`. */
export function boundWords(key: Bound['key'], value: string | null): string {
  const words: Record<Bound['key'], string> = {
    minLength: 'min length',
    maxLength: 'max length',
    minimum: 'min',
    maximum: 'max',
    exclusiveMinimum: 'more than',
    exclusiveMaximum: 'less than',
    pattern: 'pattern',
  }
  if (key === 'pattern') return value === null ? 'no pattern' : 'pattern'
  return value === null ? `no ${words[key]}` : `${words[key]} ${value}`
}

/** The chain ops that bring the rule at `path` in line with the contract, as `diff` describes. */
export function alignOps(path: string, chain: ChainCall[], diff: RuleDiff): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = []
  for (const { bound, have } of diff.bounds) {
    if (have === null) {
      ops.push({ op: 'insertCall', path, call: `${bound.method}(${bound.value}, ${JSON.stringify(bound.message)})`, before: MODIFIERS })
      continue
    }
    ops.push({ op: 'setCallArgument', path, method: bound.method, index: 0, value: bound.value })
    const message = updatedMessage(have.args[1]?.trim(), bound, have.args[0]?.trim())
    if (message !== null && message !== have.args[1]?.trim()) ops.push({ op: 'setCallArgument', path, method: bound.method, index: 1, value: message })
  }
  const calls = chain.slice(1).map((c) => c.name)
  if (diff.optional && calls.includes('optional')) ops.push({ op: 'removeCall', path, method: 'optional' })
  if (calls.includes('nullish') && (diff.optional || diff.nullable)) {
    // `.nullish()` is both: drop it, and keep the half the contract still allows.
    ops.push({ op: 'removeCall', path, method: 'nullish' })
    if (!diff.optional) ops.push({ op: 'insertCall', path, call: 'optional()', before: MODIFIERS.filter((m) => m !== 'optional' && m !== 'nullable' && m !== 'nullish') })
    if (!diff.nullable) ops.push({ op: 'insertCall', path, call: 'nullable()', before: MODIFIERS.filter((m) => m !== 'nullable' && m !== 'nullish') })
  }
  if (diff.nullable && calls.includes('nullable')) ops.push({ op: 'removeCall', path, method: 'nullable' })
  return ops
}
