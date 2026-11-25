import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { apply } from '../apply/index.js'
import { sequenceSource } from '../ids.js'
import { loadBlueprint, type Blueprint } from '../store.js'
import type { Diagnostic } from '../types/diagnostics.js'
import type { ValidationContext } from './context.js'
import { validate, validateStructure } from './index.js'

const LIST = 'pages/CustomerList.page.json'
const OVERVIEW = 'pages/CustomerOverview.page.json'
const files = readFixture(path.join(FIXTURES, 'valid/backoffice'))

const finding = (doc: string, code: string, severity: Diagnostic['severity'] = 'error'): Diagnostic =>
  ({ code, severity, doc, pointer: '', message: code })

/** A layer that records which documents it saw and reports what `report` says. */
function layer(seen: string[][], report: (bp: Blueprint) => Diagnostic[] = () => []) {
  return (bp: Blueprint) => {
    seen.push(Object.keys(bp.docs))
    return report(bp)
  }
}

describe('validate(): the layers composed (T023, FR-BP-05)', () => {
  it('is layers 1 and 2 without a context', () => {
    const bp = loadBlueprint({ ...files, [LIST]: '{' })
    expect(validate(bp)).toEqual(validateStructure(bp))
  })

  it('runs manifests, contract and expressions in order, each on the documents the earlier layers passed', () => {
    const seen: string[][] = []
    const bp = loadBlueprint({ ...files, 'pages/Broken.page.json': '{' })
    const ctx: ValidationContext = {
      manifests: layer(seen, () => [finding(OVERVIEW, 'unknown_component')]),
      contract: layer(seen, () => [finding(LIST, 'unknown_field', 'warning')]),
      expressions: layer(seen, () => [finding(LIST, 'expr_unknown_root')]),
    }
    const found = validate(bp, ctx)
    expect(seen).toEqual([
      ['app.blueprint.json', LIST, OVERVIEW],
      ['app.blueprint.json', LIST],
      ['app.blueprint.json', LIST],
    ])
    expect(found.map((d) => d.code)).toEqual(['invalid_json', 'unknown_component', 'unknown_field', 'expr_unknown_root'])
  })

  it('reports a check that throws as check_failed and runs the next layer', () => {
    const seen: string[][] = []
    const found = validate(loadBlueprint(files), {
      manifests: () => { throw new Error('manifest index unreadable') },
      contract: layer(seen),
    })
    expect(found).toMatchObject([{ code: 'check_failed', severity: 'error', doc: '', message: expect.stringContaining('manifest index unreadable') }])
    expect(seen).toHaveLength(1)
  })

  it('returns the context diagnostics of a patch without letting them block it', () => {
    const bp = loadBlueprint(files)
    const outcome = apply(bp, [{ op: 'setPageMeta', doc: LIST, baseRev: bp.docs[LIST]?.rev, public: true }], {
      ids: sequenceSource(),
      ctx: { contract: () => [finding(LIST, 'unknown_resource')] },
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.result.diagnostics.map((d) => d.code)).toEqual(['unknown_resource'])
  })
})
