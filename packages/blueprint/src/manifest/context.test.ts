import { expect, it, vi } from 'vitest'

import { apply, loadBlueprint, sequenceSource, validate } from '../index.js'
import { SCHEMA_URL } from '../types/common.js'
import { manifestCheck } from './check.js'

const doc = 'pages/Example.page.json'
const root = 'n_01JDK3M8A00000000000000001'
const document = {
  $schema: SCHEMA_URL.page, blueprintVersion: 1, id: 'pg_01JDK3M7Q2X8Y4Z6A1B3C5D7E9',
  kind: 'custom', name: 'Example', route: '/example', root,
  nodes: { [root]: { type: 'Button', name: 'save', parent: null, slot: null, order: 'a0' } },
}

it('FR-BP-05: a manifest check runs between structural and contract validation', () => {
  const invalid = { ...document, name: 'Other', route: '/other', root: 'n_01JDK3M8A00000000000000002' }
  const blueprint = loadBlueprint({
    [doc]: JSON.stringify(document),
    'pages/Other.page.json': JSON.stringify(invalid),
  })
  const contract = vi.fn(() => [])
  const findings = validate(blueprint, { manifests: manifestCheck({}), contract })
  expect(findings.filter(({ severity }) => severity === 'error')).toMatchObject([
    { code: 'dangling_reference', doc: 'pages/Other.page.json' },
    { code: 'unknown_component', doc },
  ])
  expect(contract).toHaveBeenCalledWith({ exists: true, docs: {} })
})

it('FR-BP-07: manifest diagnostics are returned with guarded ops on a draft', () => {
  const blueprint = loadBlueprint({ [doc]: JSON.stringify(document) })
  const result = apply(blueprint, [{
    op: 'setProp', doc, baseRev: blueprint.docs[doc]?.rev, node: root,
    expectedType: 'Button', prop: 'variant', value: 'brand',
  }], { ids: sequenceSource(), ctx: { manifests: manifestCheck({}) } })
  expect(result).toMatchObject({
    ok: true,
    result: { changed: true, diagnostics: expect.arrayContaining([{
      code: 'unknown_component', doc, pointer: `/nodes/${root}/type`, severity: 'error', message: 'Unknown component Button',
    }]) },
  })
})
