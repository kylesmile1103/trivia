// T020: random op sequences keep layers 1 and 2 valid. A seeded generator proposes ops that
// are well formed against the current state; the reducer may refuse some (a move into a
// subtree, a removal that would leave a dangling refetch), but whatever it accepts must leave
// no structural error, and every file it writes must already be canonical.
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { sequenceSource } from '../ids.js'
import { serialize } from '../serialize.js'
import { loadBlueprint, type Blueprint } from '../store.js'
import { ERROR_STATUS } from '../types/diagnostics.js'
import type { CustomPage } from '../types/page.js'
import { validateStructure } from '../validate/index.js'
import { apply } from './index.js'

const DOC = 'pages/CustomerOverview.page.json'

/** mulberry32: small, fast and deterministic. */
function random(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
  return { next, pick }
}

function propose(bp: Blueprint, rand: ReturnType<typeof random>, step: number): Record<string, unknown> {
  const page = bp.docs[DOC]?.doc as CustomPage
  const rev = bp.docs[DOC]?.rev
  const ids = Object.keys(page.nodes)
  const nonRoot = ids.filter((id) => id !== page.root)
  const anyNode = () => rand.pick(ids)
  const typeOf = (id: string) => page.nodes[id]?.type
  const fresh = `x${step}`
  const at = () => {
    const r = rand.next()
    return r < 0.25 ? {} : r < 0.5 ? { index: 0 } : r < 0.75 ? { index: 1 } : {}
  }
  const base = { doc: DOC, baseRev: rev }
  const nodeOp = (id: string) => ({ ...base, node: id, expectedType: typeOf(id) })
  const choices: Array<() => Record<string, unknown>> = [
    () => {
      const parent = anyNode()
      return { ...base, op: 'addNode', parent, expectedType: typeOf(parent), type: rand.pick(['div', 'span', 'Button', 'Card']), name: fresh, slot: rand.pick(['children', 'footer']), ...at() }
    },
    () => ({ op: 'removeNode', ...nodeOp(rand.pick(nonRoot.length ? nonRoot : ids)) }),
    () => ({ op: 'moveNode', ...nodeOp(rand.pick(nonRoot.length ? nonRoot : ids)), parent: anyNode(), slot: 'children', ...at() }),
    () => ({ op: 'renameNode', ...nodeOp(anyNode()), name: fresh }),
    () => ({ op: 'setProp', ...nodeOp(anyNode()), prop: rand.pick(['variant', 'title', 'children']), value: rand.pick([null, 'a', 3, true, { k: [1] }]) }),
    () => ({ op: 'setBinding', ...nodeOp(anyNode()), prop: rand.pick(['title', 'disabled', 'children']), expr: rand.pick([null, 'state.selectedId', 'data.customers.total > 1']) }),
    () => ({ op: 'setStyle', ...nodeOp(anyNode()), className: rand.pick([null, 'p-2', 'grid gap-2']) }),
    () => ({ op: 'setControl', ...nodeOp(anyNode()), control: rand.pick([null, { when: 'state.open' }, { each: 'data.customers.data', as: 'row', key: 'row.id' }]) }),
    () => ({ ...base, op: 'setState', name: rand.pick([fresh, 'selectedId', 'filters']), type: 'string | null', initial: null }),
    () => ({ ...base, op: 'removeState', name: rand.pick(Object.keys(page.state).concat('nope')) }),
    () => ({ ...base, op: 'setQuery', name: rand.pick([fresh, 'customers']), query: { kind: 'list', resource: 'Customer' } }),
    () => ({ ...base, op: 'removeQuery', name: rand.pick(Object.keys(page.queries).concat('nope')) }),
    () => ({ op: 'setActions', ...nodeOp(anyNode()), event: 'onClick', steps: rand.pick([[], [{ do: 'toast', message: "'hi'" }], [{ do: 'refetch', query: rand.pick(Object.keys(page.queries).concat('gone')) }]]) }),
  ]
  return rand.pick(choices)()
}

describe('random op sequences keep layers 1 and 2 valid (T020)', () => {
  for (const seed of [1, 7, 42, 2026, 90210]) {
    it(`seed ${seed}`, () => {
      const rand = random(seed)
      const ids = sequenceSource({ time: seed })
      let bp = loadBlueprint(readFixture(path.join(FIXTURES, 'valid/backoffice')))
      let accepted = 0
      for (let step = 0; step < 300; step++) {
        const op = propose(bp, rand, step)
        const outcome = apply(bp, [op], { ids })
        if (!outcome.ok) {
          expect(Object.keys(ERROR_STATUS)).toContain(outcome.error.code)
          // Only these can leave a step naming what is gone; any other op refused as an
          // invalid result means a handler left the page inconsistent (removeNode leaving an
          // entry of its subtree behind, a move breaking the tree).
          if (outcome.error.code === 'invalid_result') expect([step, op.op]).toEqual([step, expect.stringMatching(/^(removeQuery|removeState|setActions)$/)])
          continue
        }
        accepted++
        const errors = validateStructure(outcome.blueprint).filter((d) => d.severity === 'error')
        expect([step, op, errors]).toEqual([step, op, []])
        for (const write of outcome.writes) {
          const entry = outcome.blueprint.docs[write.file]
          if (write.after !== null && entry?.doc) expect(serialize(entry.doc)).toBe(write.after)
        }
        bp = outcome.blueprint
      }
      // The generator is useful only if most proposals go through.
      expect(accepted).toBeGreaterThan(150)
    })
  }
})
