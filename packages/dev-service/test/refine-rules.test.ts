// A rule against its contract field (src/refine/rules.ts): which bounds differ, what `align`
// writes, and when a message follows its bound.

import { describe, expect, it } from 'vitest'

import { boundsOf } from '../src/refine/fields.js'
import { alignOps, ruleDiff, updatedMessage } from '../src/refine/rules.js'

const text = (constraints: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  name: 'notes',
  type: 'string' as const,
  format: null,
  enum: null,
  required: false,
  nullable: false,
  constraints,
  ...more,
})
const chain = (...calls: Array<[string, ...string[]]>) => calls.map(([name, ...args]) => ({ name, args }))

describe('ruleDiff', () => {
  it('compares only the bounds the contract states', () => {
    const rule = chain(['z.string'], ['min', '5'], ['max', '100', '"At most 100."'], ['optional'])
    const diff = ruleDiff(rule, text({ maxLength: 500 }))!
    expect(diff.bounds.map((b) => [b.bound.key, b.have?.args[0] ?? null, b.bound.value])).toEqual([['maxLength', '100', '500']])
    expect(diff.optional).toBe(false)
    expect(ruleDiff(rule, text({}))!.bounds).toEqual([])
  })

  it('has no verdict on a pattern written another way, or a bound called twice, or a rule that is not zod', () => {
    expect(ruleDiff(chain(['z.string'], ['regex', '/^[A-Z]+$/']), text({ pattern: '^[a-z]+$' }))!.bounds).toEqual([])
    expect(ruleDiff(chain(['z.string'], ['max', '3'], ['max', '4']), text({ maxLength: 5 }))!.bounds).toEqual([])
    expect(ruleDiff(chain(['nameRule.optional']), text({ maxLength: 5 }))).toBeNull()
    expect(ruleDiff(null, text({}))).toBeNull()
  })

  it('flags a rule that lets through what the contract refuses, not one that is stricter', () => {
    const required = text({}, { required: true })
    expect(ruleDiff(chain(['z.string'], ['optional']), required)).toMatchObject({ optional: true, nullable: false })
    expect(ruleDiff(chain(['z.string'], ['nullish']), required)).toMatchObject({ optional: true, nullable: true })
    expect(ruleDiff(chain(['z.string']), text({}))).toMatchObject({ optional: false, nullable: false })
  })
})

describe('alignOps', () => {
  const path = 'src/f.tsx#module#schema.notes'
  it('sets a differing bound, its message when it names the bound, and inserts a missing one before the modifiers', () => {
    const rule = chain(['z.string'], ['max', '100', '"Notes must be 100 characters or fewer"'], ['optional'])
    const ops = alignOps(path, rule, ruleDiff(rule, text({ minLength: 2, maxLength: 1000 }))!)
    expect(ops).toEqual([
      { op: 'insertCall', path, call: 'min(2, "Enter at least 2 characters.")', before: expect.arrayContaining(['optional', 'refine']) },
      { op: 'setCallArgument', path, method: 'max', index: 0, value: '1000' },
      { op: 'setCallArgument', path, method: 'max', index: 1, value: '"Notes must be 1000 characters or fewer"' },
    ])
  })

  it('splits .nullish() into the half the contract still allows', () => {
    const rule = chain(['z.string'], ['nullish'])
    const nullable = text({}, { required: true, nullable: true })
    expect(alignOps(path, rule, ruleDiff(rule, nullable)!).map((o) => `${o['op']} ${o['method'] ?? o['call']}`)).toEqual([
      'removeCall nullish',
      'insertCall nullable()',
    ])
    const optional = text({}, { required: false, nullable: false })
    expect(alignOps(path, rule, ruleDiff(rule, optional)!).map((o) => `${o['op']} ${o['method'] ?? o['call']}`)).toEqual([
      'removeCall nullish',
      'insertCall optional()',
    ])
  })
})

describe('updatedMessage', () => {
  const max = boundsOf(text({ maxLength: 500 }))[0]!
  const min = boundsOf(text({ minLength: 3 }))[0]!
  it('replaces the old bound when the message names it exactly once', () => {
    expect(updatedMessage('"At most 100 characters"', max, '100')).toBe('"At most 500 characters"')
    expect(updatedMessage("'100 max'", max, '100')).toBe("'500 max'")
    expect(updatedMessage('"100 of 100"', max, '100')).toBeNull()
    expect(updatedMessage('"Too long"', max, '100')).toBeNull()
    expect(updatedMessage('"1000 is fine, 100 is not"', max, '100')).toBe('"1000 is fine, 500 is not"')
    expect(updatedMessage('{ message: "At most 100" }', max, '100')).toBeNull()
    expect(updatedMessage(undefined, max, '100')).toBeNull()
  })

  it('rewrites Trivia\'s own "Required." when the minimum moves off 1', () => {
    expect(updatedMessage('"Required."', min, '1')).toBe('"Enter at least 3 characters."')
    expect(updatedMessage('"Please fill this in."', min, '1')).toBeNull()
  })
})
