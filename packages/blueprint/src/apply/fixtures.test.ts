import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture, renderWrites } from '../../test/helpers.js'
import { sequenceSource } from '../ids.js'
import { loadBlueprint } from '../store.js'
import { apply } from './index.js'

interface Case {
  base: string
  ops: Array<Record<string, unknown>>
  created?: Record<string, string>
  error?: { code: string; op?: number }
}

const root = path.join(FIXTURES, 'ops')

describe('op fixtures: before, ops, after (US2, SC-002)', () => {
  for (const name of fs.readdirSync(root).sort()) {
    it(name, () => {
      const spec = JSON.parse(fs.readFileSync(path.join(root, name, 'ops.json'), 'utf8')) as Case
      const bp = loadBlueprint(spec.base === 'none' ? {} : readFixture(path.join(FIXTURES, spec.base)))
      // "@current" is the rev the author read: the document's rev in the base.
      const ops = spec.ops.map((op) => (op.baseRev === '@current' ? { ...op, baseRev: bp.docs[op.doc as string]?.rev } : op))
      const outcome = apply(bp, ops, { ids: sequenceSource() })
      if (spec.error) {
        expect(outcome.ok ? 'applied' : { code: outcome.error.code, op: outcome.error.op }).toEqual(spec.error)
        return
      }
      if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.error)}`)
      expect(renderWrites(outcome.writes)).toBe(fs.readFileSync(path.join(root, name, 'expected.diff'), 'utf8'))
      expect(outcome.result.created).toEqual(spec.created ?? {})
      expect(outcome.result.changed).toBe(true)
    })
  }
})
