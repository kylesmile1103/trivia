import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { sequenceSource } from '../ids.js'
import { loadBlueprint } from '../store.js'
import { apply } from './index.js'

const LIST = 'pages/CustomerList.page.json'
const OVERVIEW = 'pages/CustomerOverview.page.json'
const STALE = 'sha256:' + '0'.repeat(64)
const files = readFixture(path.join(FIXTURES, 'valid/backoffice'))
const bp = loadBlueprint(files)
const rev = (doc: string) => bp.docs[doc]?.rev ?? null
const options = { ids: sequenceSource() }

describe('the batch reducer guards (T018, FR-BP-07)', () => {
  it('refuses a stale baseRev with 409 conflict and the current revs, before running any op', () => {
    const outcome = apply(bp, [
      { op: 'setPageMeta', doc: OVERVIEW, baseRev: rev(OVERVIEW), route: '/overview' },
      { op: 'setPageMeta', doc: LIST, baseRev: STALE, route: '/clients' },
    ], options)
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: 'conflict', status: 409, op: 1,
      details: { doc: LIST, expected: STALE, actual: rev(LIST), revs: { [OVERVIEW]: rev(OVERVIEW), [LIST]: rev(LIST) } },
    })
  })

  it('sees a hand edit between the read and the patch through the rev', () => {
    const edited = loadBlueprint({ ...files, [LIST]: (files[LIST] as string).replace('"Customers"', '"Clients"') })
    const outcome = apply(edited, [{ op: 'setPageMeta', doc: LIST, baseRev: rev(LIST), public: true }], options)
    expect(outcome.ok ? 'applied' : outcome.error.code).toBe('conflict')
  })

  it('refuses null for an existing document and a rev for a missing one', () => {
    const exists = apply(bp, [{ op: 'deletePage', doc: LIST, baseRev: null }], options)
    expect(exists.ok ? 'applied' : outcome(exists)).toEqual({ code: 'conflict', op: 0 })
    const missing = apply(bp, [{ op: 'setPageMeta', doc: 'pages/Nope.page.json', baseRev: STALE, public: true }], options)
    expect(missing.ok ? 'applied' : outcome(missing)).toEqual({ code: 'conflict', op: 0 })
  })

  it('refuses an op that is not a BlueprintOp with 400 invalid_op and the issues', () => {
    const outcome = apply(bp, [{ op: 'addNode', doc: OVERVIEW, baseRev: rev(OVERVIEW) }], options)
    expect(outcome.ok ? null : outcome.error).toMatchObject({ code: 'invalid_op', status: 400, op: 0 })
    expect(outcome.ok ? [] : (outcome.error.details?.issues as unknown[])).not.toHaveLength(0)
  })

  it('refuses a missing node with 404 node_not_found and a type mismatch with 409', () => {
    const missing = apply(bp, [{ op: 'removeNode', doc: OVERVIEW, baseRev: rev(OVERVIEW), node: 'n_01JDK3M8A0000000000000000Z', expectedType: 'div' }], options)
    expect(missing.ok ? null : missing.error).toMatchObject({ code: 'node_not_found', status: 404, details: { node: 'n_01JDK3M8A0000000000000000Z' } })
    const mismatch = apply(bp, [{ op: 'removeNode', doc: OVERVIEW, baseRev: rev(OVERVIEW), node: 'n_01JDK3M8A00000000000000005', expectedType: 'Button' }], options)
    expect(mismatch.ok ? null : mismatch.error).toMatchObject({
      code: 'conflict', status: 409, details: { node: 'n_01JDK3M8A00000000000000005', expectedType: 'Button', actualType: 'Card' },
    })
  })

  it('refuses a result with a new structural error with 422 invalid_result and the diagnostics', () => {
    const outcome = apply(bp, [{ op: 'setPageMeta', doc: LIST, baseRev: rev(LIST), route: '/customers/overview' }], options)
    expect(outcome.ok ? null : outcome.error).toMatchObject({ code: 'invalid_result', status: 422 })
    const diagnostics = outcome.ok ? [] : (outcome.error.details?.diagnostics as Array<{ code: string }>)
    expect(diagnostics.map((d) => d.code)).toContain('duplicate_route')
  })

  it('does not let an error that was already there block an unrelated batch', () => {
    const broken = loadBlueprint({ ...files, 'pages/Broken.page.json': '{' })
    const outcome = apply(broken, [{ op: 'setPageMeta', doc: LIST, baseRev: broken.docs[LIST]?.rev, public: true }], options)
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.result.diagnostics.map((d) => d.code)).toEqual(['invalid_json'])
  })

  it('writes nothing for a refused batch, and nothing for a batch that changes nothing', () => {
    const refused = apply(bp, [
      { op: 'setPageMeta', doc: LIST, baseRev: rev(LIST), public: true },
      { op: 'deletePage', doc: 'pages/Nope.page.json', baseRev: null },
    ], options)
    expect(refused.ok).toBe(false)
    expect('writes' in refused).toBe(false)
    const same = apply(bp, [{ op: 'setPageMeta', doc: LIST, baseRev: rev(LIST), route: '/customers' }], options)
    expect(same.ok && { changed: same.result.changed, writes: same.writes }).toEqual({ changed: false, writes: [] })
  })

  it('returns the new revs, and leaves the input blueprint untouched', () => {
    const before = JSON.stringify(bp)
    const outcome = apply(bp, [{ op: 'setPageMeta', doc: LIST, baseRev: rev(LIST), public: true }], options)
    expect(JSON.stringify(bp)).toBe(before)
    expect(outcome.ok && outcome.result.revs[LIST]).toBe(outcome.ok && outcome.blueprint.docs[LIST]?.rev)
    expect(outcome.ok && outcome.result.revs[LIST]).not.toBe(rev(LIST))
  })
})

function outcome(result: { ok: false; error: { code: string; op?: number } }) {
  return { code: result.error.code, op: result.error.op }
}
