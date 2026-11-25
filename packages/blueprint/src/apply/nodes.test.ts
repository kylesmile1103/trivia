import path from 'node:path'

import { renameReferences } from '@trivia/engine'
import { describe, expect, it, vi } from 'vitest'

import { FIXTURES, readFixture, renderWrites } from '../../test/helpers.js'
import { sequenceSource } from '../ids.js'
import { loadBlueprint, type Blueprint } from '../store.js'
import type { CustomPage } from '../types/page.js'
import { apply, type ApplyOptions } from './index.js'

const DOC = 'pages/CustomerOverview.page.json'
const n = (i: number) => `n_01JDK3M8A0000000000000000${i}`
const NEW = 'n_00000000000000000000000001'
const files = readFixture(path.join(FIXTURES, 'valid/backoffice'))

function blueprint(edit?: (page: Record<string, any>) => void): Blueprint {
  if (!edit) return loadBlueprint(files)
  const page = JSON.parse(files[DOC] as string)
  edit(page)
  return loadBlueprint({ ...files, [DOC]: JSON.stringify(page, null, 2) + '\n' })
}

function run(ops: Array<Record<string, unknown>>, bp = blueprint(), options: Partial<ApplyOptions> = {}) {
  const withRevs = ops.map((op) => ({ doc: DOC, baseRev: bp.docs[(op.doc as string | undefined) ?? DOC]?.rev, ...op }))
  return apply(bp, withRevs, { ids: sequenceSource(), ...options })
}

function page(outcome: ReturnType<typeof run>): CustomPage {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
  return outcome.blueprint.docs[DOC]?.doc as CustomPage
}

const refusal = (outcome: ReturnType<typeof run>) => (outcome.ok ? 'applied' : outcome.error.code)

describe('addNode (T014, US2 scenario 1)', () => {
  it('generates an id and an order key between its neighbours, and changes only its own entry', () => {
    const outcome = run([{ op: 'addNode', parent: n(2), expectedType: 'div', type: 'span', name: 'badge', slot: 'children', after: n(3) }])
    expect(page(outcome).nodes[NEW]).toEqual({ type: 'span', name: 'badge', parent: n(2), slot: 'children', order: 'a0V' })
    expect(outcome.ok && outcome.result.created).toEqual({ 'CustomerOverview/badge': NEW })
    expect(outcome.ok && renderWrites(outcome.writes)).toBe(`--- a/${DOC}\n+++ b/${DOC}\n` + [
      `+    "${NEW}": {`, '+      "type": "span",', '+      "name": "badge",', `+      "parent": "${n(2)}",`,
      '+      "slot": "children",', '+      "order": "a0V"', '+    },',
    ].map((l) => l + '\n').join(''))
  })

  it('places by before, index, or last when no position is given', () => {
    const order = (position: Record<string, unknown>) =>
      page(run([{ op: 'addNode', parent: n(2), expectedType: 'div', type: 'span', name: 'badge', slot: 'children', ...position }])).nodes[NEW]?.order
    expect(order({ before: n(3) })).toBe('Zz')
    expect(order({ index: 1 })).toBe('a0V')
    expect(order({ index: 2 })).toBe('a2')
    expect(order({})).toBe('a2')
    expect(order({ index: 0 })).toBe('Zz')
  })

  it('refuses a missing parent, a wrong parent type, a taken name, a bad position and a contract page', () => {
    const add = (extra: Record<string, unknown>) =>
      refusal(run([{ op: 'addNode', parent: n(2), expectedType: 'div', type: 'span', name: 'badge', slot: 'children', ...extra }]))
    expect(add({ parent: 'n_01JDK3M8A0000000000000000Z' })).toBe('node_not_found')
    expect(add({ expectedType: 'Card' })).toBe('conflict')
    expect(add({ name: 'title' })).toBe('conflict')
    expect(add({ name: 'selectedId' })).toBe('conflict')
    expect(add({ before: n(3), after: n(4) })).toBe('invalid_op')
    expect(add({ index: 3 })).toBe('invalid_op')
    expect(add({ before: n(5) })).toBe('invalid_op')
    expect(add({ doc: 'pages/CustomerList.page.json' })).toBe('invalid_op')
  })

  it('refuses to insert between two siblings that share an order key', () => {
    const bp = blueprint((p) => { p.nodes[n(4)].order = 'a0' })
    expect(refusal(run([{ op: 'addNode', parent: n(2), expectedType: 'div', type: 'span', name: 'badge', slot: 'children', after: n(3) }], bp)))
      .toBe('invalid_op')
  })
})

describe('removeNode (T014, US2 scenario 4)', () => {
  it("removes the node's subtree from every map", () => {
    const after = page(run([{ op: 'removeNode', node: n(5), expectedType: 'Card' }]))
    expect(Object.keys(after.nodes).sort()).toEqual([n(1), n(2), n(3), n(4), n(8), n(9)])
    for (const map of [after.props, after.bindings, after.styles, after.control]) {
      for (const gone of [n(5), n(6), n(7)]) expect(map).not.toHaveProperty([gone])
    }
    expect(Object.keys(after.actions).sort()).toEqual([`${n(4)}.onClick`, `${n(8)}.onClick`, `${n(9)}.onClick`])
    expect(after.state).toHaveProperty(['selectedId'])
  })

  it('refuses the root, a missing node and a wrong type', () => {
    expect(refusal(run([{ op: 'removeNode', node: n(1), expectedType: 'div' }]))).toBe('invalid_op')
    expect(refusal(run([{ op: 'removeNode', node: 'n_01JDK3M8A0000000000000000Z', expectedType: 'div' }]))).toBe('node_not_found')
    expect(refusal(run([{ op: 'removeNode', node: n(5), expectedType: 'div' }]))).toBe('conflict')
  })
})

describe('moveNode (T014)', () => {
  it("changes the moved node's parent, slot and order lines only", () => {
    const outcome = run([{ op: 'moveNode', node: n(9), expectedType: 'Button', parent: n(2), slot: 'children', before: n(3) }])
    expect(page(outcome).nodes[n(9)]).toMatchObject({ parent: n(2), slot: 'children', order: 'Zz' })
    expect(outcome.ok && renderWrites(outcome.writes)).toBe(`--- a/${DOC}\n+++ b/${DOC}\n` + [
      `-      "parent": "${n(1)}",`, `+      "parent": "${n(2)}",`, '-      "order": "a3"', '+      "order": "Zz"',
    ].map((l) => l + '\n').join(''))
  })

  it('moves among its own siblings without counting itself', () => {
    expect(page(run([{ op: 'moveNode', node: n(8), expectedType: 'Button', parent: n(1), slot: 'children', index: 0 }])).nodes[n(8)]?.order).toBe('Zz')
    expect(page(run([{ op: 'moveNode', node: n(2), expectedType: 'div', parent: n(1), slot: 'children', after: n(9) }])).nodes[n(2)]?.order).toBe('a4')
  })

  it('refuses the root, a move into its own subtree, a sibling that is itself, a missing parent and a wrong type', () => {
    const move = (extra: Record<string, unknown>) =>
      refusal(run([{ op: 'moveNode', node: n(5), expectedType: 'Card', parent: n(2), slot: 'children', ...extra }]))
    expect(refusal(run([{ op: 'moveNode', node: n(1), expectedType: 'div', parent: n(2), slot: 'children' }]))).toBe('invalid_op')
    expect(move({ parent: n(6) })).toBe('invalid_op')
    expect(move({ parent: n(5) })).toBe('invalid_op')
    expect(move({ parent: n(1), after: n(5) })).toBe('invalid_op')
    expect(move({ parent: 'n_01JDK3M8A0000000000000000Z' })).toBe('node_not_found')
    expect(move({ expectedType: 'Button' })).toBe('conflict')
  })
})

describe('renameNode (T014)', () => {
  it('renames a node nothing refers to: one line', () => {
    const outcome = run([{ op: 'renameNode', node: n(4), expectedType: 'Button', name: 'reload' }])
    expect(page(outcome).nodes[n(4)]?.name).toBe('reload')
    expect(outcome.ok && renderWrites(outcome.writes)).toBe(`--- a/${DOC}\n+++ b/${DOC}\n-      "name": "refresh",\n+      "name": "reload",\n`)
  })

  it('rewrites ui.<name> references through the injected expression tools', () => {
    const bp = blueprint((p) => { p.bindings[n(5)].title = 'ui.title.text' ; p.control[n(4)].when = 'ui["title"] && true' })
    const expressions = { renameNodeReference: (expr: string, from: string, to: string) => expr.replaceAll(`ui.${from}`, `ui.${to}`).replaceAll(`ui["${from}"]`, `ui["${to}"]`) }
    const after = page(run([{ op: 'renameNode', node: n(3), expectedType: 'h1', name: 'heading' }], bp, { expressions }))
    expect(after.bindings[n(5)]?.title).toBe('ui.heading.text')
    expect(after.control[n(4)]).toEqual({ when: 'ui["heading"] && true' })
  })

  it('batches the native rename across stored expressions while respecting repeat aliases', () => {
    const bp = blueprint((p) => {
      p.bindings[n(5)].title = "ui /* keep */ .title.text + ui?.title.text + 'ui.title'"
      p.bindings[n(7)].children = 'ui.title.text'
      p.control[n(7)] = { each: "ui['title'].items", as: 'ui', key: 'ui.title.id' }
      p.queries.selected.params.id = 'ui[`title`].id'
      p.actions[`${n(4)}.onClick`][1].message = 'ui.title.text'
      p.props[n(3)].children = 'ui.title'
    })
    const rename = vi.fn(renameReferences)
    const outcome = run([{ op: 'renameNode', node: n(3), expectedType: 'h1', name: 'heading' }], bp, {
      expressions: { renameReferences: rename },
    })
    const after = page(outcome)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(after.nodes[n(3)]?.name).toBe('heading')
    expect(after.bindings[n(5)]?.title).toBe("ui /* keep */ .heading.text + ui?.heading.text + 'ui.title'")
    expect(after.bindings[n(7)]?.children).toBe('ui.title.text')
    expect(after.control[n(7)]).toEqual({ each: "ui['heading'].items", as: 'ui', key: 'ui.title.id' })
    expect(after.queries.selected?.params.id).toBe('ui[`heading`].id')
    expect(after.actions[`${n(4)}.onClick`]?.[1]).toEqual({ do: 'toast', message: 'ui.heading.text' })
    expect(after.props[n(3)]?.children).toBe('ui.title')
    expect(outcome.ok && outcome.writes.map(({ file }) => file)).toEqual([DOC])
  })

  it('refuses the whole batch if a possibly affected source cannot be renamed', () => {
    const bp = blueprint((p) => {
      p.bindings[n(5)].title = 'ui.title.text'
      p.control[n(4)].when = 'ui.title +'
    })
    const outcome = run([{ op: 'renameNode', node: n(3), expectedType: 'h1', name: 'heading' }], bp, {
      expressions: { renameReferences },
    })
    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid_op', op: 0, details: {
      pointers: [`/control/${n(4)}/when`],
      diagnostics: [{ code: 'expr_unsupported_syntax' }],
    } } })
    expect(outcome).not.toHaveProperty('writes')
    expect((bp.docs[DOC]?.doc as CustomPage).nodes[n(3)]?.name).toBe('title')
    expect((bp.docs[DOC]?.doc as CustomPage).bindings[n(5)]?.title).toBe('ui.title.text')
  })

  it('refuses without the expression tools when an expression refers to the node, naming where', () => {
    const bp = blueprint((p) => { p.bindings[n(5)].title = 'ui.title.text' })
    const outcome = run([{ op: 'renameNode', node: n(3), expectedType: 'h1', name: 'heading' }], bp)
    expect(outcome.ok ? null : outcome.error).toMatchObject({ code: 'invalid_op', op: 0, details: { pointers: [`/bindings/${n(5)}/title`] } })
  })

  it('refuses a taken name and a wrong type; renaming to its own name changes nothing', () => {
    expect(refusal(run([{ op: 'renameNode', node: n(4), expectedType: 'Button', name: 'title' }]))).toBe('conflict')
    expect(refusal(run([{ op: 'renameNode', node: n(4), expectedType: 'Button', name: 'customers' }]))).toBe('conflict')
    expect(refusal(run([{ op: 'renameNode', node: n(4), expectedType: 'Card', name: 'reload' }]))).toBe('conflict')
    const same = run([{ op: 'renameNode', node: n(4), expectedType: 'Button', name: 'refresh' }])
    expect(same.ok && same.result.changed).toBe(false)
  })
})
