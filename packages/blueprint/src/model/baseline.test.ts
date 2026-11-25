import fs from 'node:fs'

import { expect, it } from 'vitest'

import { sequenceSource } from '../ids.js'
import {
  apply, loadBlueprint, MODEL_DOC, modelSchema, revOfText, serialize, summarizeModel, validate,
  type ModelDoc,
} from '../index.js'

const source = fs.readFileSync(new URL('../../fixtures/model/valid/bank/model.blueprint.json', import.meta.url), 'utf8')
const baseline = summarizeModel(modelSchema.parse(JSON.parse(source)), revOfText(source))
const model = () => modelSchema.parse(JSON.parse(source))
const findings = (value: ModelDoc) => validate(loadBlueprint({ [MODEL_DOC]: serialize(value) }), { modelBaseline: baseline })

it('warns about removed fields, narrower types and new required fields without defaults', () => {
  const changed = model()
  const customer = changed.entities[0]!
  customer.fields = customer.fields
    .filter(({ name }) => name !== 'birthDate')
    .map((field) => field.name === 'creditLimit' ? { name: field.name, type: 'int', default: 0 } : field)
  customer.fields.push(
    { name: 'membershipNumber', type: 'string', required: true },
    { name: 'regionCode', type: 'string', required: true, default: 'local' },
  )
  const actual = findings(changed)
  expect(actual).toHaveLength(3)
  expect(actual).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'breaking_change', severity: 'warning', doc: MODEL_DOC,
      pointer: '/entities/0/fields', message: expect.stringContaining('Customer.birthDate') }),
    expect.objectContaining({ code: 'breaking_change', severity: 'warning', doc: MODEL_DOC,
      pointer: '/entities/0/fields/3', message: expect.stringContaining('Customer.creditLimit') }),
    expect.objectContaining({ code: 'breaking_change', severity: 'warning', doc: MODEL_DOC,
      pointer: '/entities/0/fields/7', message: expect.stringContaining('existing rows need a value') }),
  ]))
})

it('recognizes tighter bounds and removed enum values while allowing new optional fields and wider shapes', () => {
  const changed = model()
  const customer = changed.entities[0]!
  customer.fields = customer.fields.map((field) =>
    field.type === 'string' && field.name === 'fullName' ? { ...field, maxLength: 50 } : field)
  customer.fields.push({ name: 'membershipNumber', type: 'string' })
  changed.enums[0]!.values = ['pending', 'active', 'requested']
  const actual = findings(changed)
  expect(actual.map(({ message }) => message)).toEqual([
    expect.stringContaining('Customer.fullName'),
    expect.stringContaining('Customer.status'),
  ])

  const wider = model()
  wider.entities[0]!.fields = wider.entities[0]!.fields.map((field) =>
    field.type === 'string' && field.name === 'fullName' ? { ...field, type: 'text', maxLength: 200 } : field)
  wider.enums[0]!.values.push('requested')
  expect(findings(wider)).toEqual([])
})

it('reports warnings on a model operation without blocking the change', () => {
  const blueprint = loadBlueprint({ [MODEL_DOC]: source })
  expect(validate(blueprint, { modelBaseline: baseline })).toEqual([])
  const result = apply(blueprint, [{
    op: 'removeField', doc: MODEL_DOC, baseRev: baseline.rev, entity: 'Customer', field: 'birthDate',
  }], { ids: sequenceSource(), ctx: { modelBaseline: baseline } })
  expect(result).toMatchObject({
    ok: true,
    result: { changed: true, diagnostics: [expect.objectContaining({
      code: 'breaking_change', severity: 'warning', message: expect.stringContaining('Customer.birthDate'),
    })] },
  })
})
