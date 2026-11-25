import { describe, expect, it } from 'vitest'

import { DIAGNOSTIC_CODES, ERROR_STATUS, toPointer } from './diagnostics.js'
import { OP_NAMES, blueprintOpSchema } from './ops.js'

const page = 'pages/CustomerOverview.page.json'
const rev = 'sha256:' + '0'.repeat(64)
const node = 'n_01JDK3M8A00000000000000004'

describe('BlueprintOp schema (FR-BP-07)', () => {
  const valid = [
    { op: 'setApp', doc: 'app.blueprint.json', baseRev: rev, name: 'Shop', theme: { tokens: { radius: null } } },
    { op: 'setNav', doc: 'app.blueprint.json', baseRev: rev, nav: [{ page: 'CustomerList', label: 'Customers' }] },
    { op: 'createPage', doc: 'pages/Orders.page.json', baseRev: null, name: 'Orders', route: '/orders', kind: 'list', resource: 'Order' },
    { op: 'deletePage', doc: page, baseRev: rev },
    { op: 'setPageMeta', doc: page, baseRev: rev, route: '/overview', public: true },
    { op: 'addNode', doc: page, baseRev: rev, parent: node, expectedType: 'Button', type: 'span', name: 'label', slot: 'children', index: 0 },
    { op: 'removeNode', doc: page, baseRev: rev, node, expectedType: 'Button' },
    { op: 'moveNode', doc: page, baseRev: rev, node, expectedType: 'Button', parent: node, slot: 'children', after: node },
    { op: 'renameNode', doc: page, baseRev: rev, node, expectedType: 'Button', name: 'reload' },
    { op: 'setProp', doc: page, baseRev: rev, node, expectedType: 'Button', prop: 'variant', value: null },
    { op: 'setBinding', doc: page, baseRev: rev, node, expectedType: 'Button', prop: 'disabled', expr: 'state.busy' },
    { op: 'setStyle', doc: page, baseRev: rev, node, expectedType: 'Button', className: 'w-full' },
    { op: 'setControl', doc: page, baseRev: rev, node, expectedType: 'Button', control: { when: 'state.open' } },
    { op: 'setState', doc: page, baseRev: rev, name: 'busy', type: 'boolean', initial: false },
    { op: 'removeState', doc: page, baseRev: rev, name: 'busy' },
    { op: 'setQuery', doc: page, baseRev: rev, name: 'orders', query: { kind: 'list', resource: 'Order' } },
    { op: 'removeQuery', doc: page, baseRev: rev, name: 'orders' },
    { op: 'setActions', doc: page, baseRev: rev, node, expectedType: 'Button', event: 'onClick', steps: [{ do: 'refetch', query: 'orders' }] },
  ]

  it('accepts one example of every op', () => {
    expect(valid.map((op) => op.op).sort()).toEqual([...OP_NAMES].sort())
    for (const op of valid) expect([op.op, blueprintOpSchema.safeParse(op).error?.issues]).toEqual([op.op, undefined])
  })

  it('requires baseRev on every op, and expectedType on node ops', () => {
    for (const op of valid) {
      const { baseRev: _baseRev, ...rest } = op
      expect([op.op, blueprintOpSchema.safeParse(rest).success]).toEqual([op.op, false])
      if ('expectedType' in op) {
        const { expectedType: _type, ...untyped } = op
        expect([op.op, blueprintOpSchema.safeParse(untyped).success]).toEqual([op.op, false])
      }
    }
  })

  it('refuses an unknown op, two positions, and a document path outside the blueprint', () => {
    expect(blueprintOpSchema.safeParse({ op: 'setEntity', doc: 'model.blueprint.json', baseRev: rev }).success).toBe(false)
    expect(blueprintOpSchema.safeParse({ ...valid[7], before: node }).success).toBe(false)
    expect(blueprintOpSchema.safeParse({ ...valid[3], doc: '../app.blueprint.json' }).success).toBe(false)
    expect(blueprintOpSchema.safeParse({ ...valid[3], doc: 'pages/x.page.json' }).success).toBe(false)
  })
})

describe('diagnostics (FR-BP-05)', () => {
  it('writes RFC 6901 pointers', () => {
    expect(toPointer([])).toBe('')
    expect(toPointer(['bindings', 'n_1', 'title'])).toBe('/bindings/n_1/title')
    expect(toPointer(['a/b', 'c~d', 0])).toBe('/a~1b/c~0d/0')
  })

  it('names every code of the layers this package runs, and maps error codes to HTTP statuses', () => {
    for (const code of ['schema_violation', 'dangling_reference', 'duplicate_name', 'duplicate_route', 'parent_cycle',
      'duplicate_prop', 'invalid_json', 'unsupported_version']) {
      expect(DIAGNOSTIC_CODES).toContain(code)
    }
    expect(ERROR_STATUS).toEqual({ conflict: 409, node_not_found: 404, invalid_op: 400, invalid_result: 422 })
  })
})
