import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { apply } from '../apply/index.js'
import { sequenceSource } from '../ids.js'
import { loadBlueprint } from '../store.js'
import { blueprintOpSchema } from '../types/ops.js'
import { validateStructure } from './index.js'

const load = (fixture: string) => loadBlueprint(readFixture(path.join(FIXTURES, 'invalid', fixture)))

/** The diagnostic's hint ops, applied as a batch, leave no diagnostic of that code. */
function applyHint(fixture: string, code: string) {
  const bp = load(fixture)
  const diagnostic = validateStructure(bp).find((d) => d.code === code)
  const ops = diagnostic?.hint?.ops ?? []
  for (const op of ops) expect(blueprintOpSchema.safeParse(op).success).toBe(true)
  const outcome = apply(bp, ops, { ids: sequenceSource() })
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
  return { diagnostic, ops, after: validateStructure(outcome.blueprint) }
}

describe('fix hints (T024, US3 scenario 2)', () => {
  it('names the prop that is both static and bound and carries the op that removes one of the two', () => {
    const { diagnostic, ops, after } = applyHint('duplicate_prop/static-and-bound', 'duplicate_prop')
    expect(diagnostic?.message).toContain('"children"')
    expect(ops).toMatchObject([{ op: 'setProp', prop: 'children', value: null, expectedType: 'Button' }])
    expect(diagnostic?.hint?.text).toContain('setBinding')
    expect(after.filter((d) => d.code === 'duplicate_prop')).toEqual([])
  })

  it('carries the setNav that drops a nav entry naming a missing page', () => {
    const { ops, after } = applyHint('dangling_reference/nav-page', 'dangling_reference')
    expect(ops).toMatchObject([{ op: 'setNav', doc: 'app.blueprint.json', nav: [{ page: 'Home', label: 'Home' }] }])
    expect(after).toEqual([])
  })

  it('advises in words where no single op fixes it', () => {
    const missing = validateStructure(load('missing_document/app'))[0]
    expect(missing?.hint).toEqual({ text: expect.stringContaining('setApp') })
    const order = validateStructure(load('duplicate_order/siblings'))[0]
    expect(order?.hint).toEqual({ text: expect.stringContaining('moveNode') })
  })
})
