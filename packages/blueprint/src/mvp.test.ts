import path from 'node:path'

import { expect, it } from 'vitest'

import { readFixture } from '../test/helpers.js'
import { loadBlueprint, MODEL_DOC, serialize, validate } from './index.js'

it('FR-MVP-01, FR-MVP-02: the example is a canonical blueprint for the bank admin', () => {
  const blueprint = loadBlueprint(readFixture(path.resolve(import.meta.dirname, '../../../examples/blueprint-mvp/blueprint')))
  expect(validate(blueprint)).toEqual([])
  const model = blueprint.docs[MODEL_DOC]?.doc
  expect(model).toMatchObject({
    enums: [{ name: 'CustomerStatus' }, { name: 'AccountType' }],
    entities: [
      { name: 'Customer', api: { custom: [{ name: 'approveKyc' }] } },
      { name: 'Account', relations: [{ kind: 'belongsTo', to: 'Customer', foreignKey: 'customerId' }] },
    ],
  })
  const pages = Object.values(blueprint.docs).flatMap(({ doc }) => doc && 'route' in doc ? [doc] : [])
  expect(pages).toMatchObject([
    { kind: 'list', resource: 'Account', options: { filters: ['customerId'] } },
    { kind: 'create', resource: 'Customer' },
    { kind: 'edit', resource: 'Customer' },
    { kind: 'list', resource: 'Customer', options: {
      filters: ['status', 'email'],
      rowActions: [{ name: 'approveKyc', confirm: 'Approve KYC for this customer?' }],
      headerActions: [{ label: 'Refresh', steps: [{ do: 'refetch' }] }],
    } },
    { kind: 'show', resource: 'Customer' },
  ])
  for (const { doc, text } of Object.values(blueprint.docs)) {
    expect(doc).not.toBeNull()
    if (doc) expect(serialize(doc)).toBe(text)
  }
})
