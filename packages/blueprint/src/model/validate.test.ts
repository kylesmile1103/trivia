import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { apply, loadBlueprint, sequenceSource } from '../index.js'
import { rev, revOfText } from '../serialize.js'
import { MODEL_DOC } from '../types/ops.js'
import { modelSchema } from './types.js'
import { modelFieldTypes, validateModel } from './validate.js'

const fixtures = `${FIXTURES}/model`

function validate(text: string) {
  return validateModel(modelSchema.parse(JSON.parse(text)), revOfText(text))
}

function expectFixtureDiagnostic(code: string): void {
  const dir = `${fixtures}/invalid/${code}`
  const text = readFixture(dir)[MODEL_DOC]!
  const expected = JSON.parse(fs.readFileSync(`${dir}/expected.json`, 'utf8'))
  expect(validate(text)).toMatchObject(expected.map((diagnostic: object) => ({
    code, severity: 'error', doc: MODEL_DOC, ...diagnostic,
  })))
}

describe('FR-DM-03: model names, constraints and defaults', () => {
  it('reports no findings for the bank model', () => {
    const text = readFixture(`${fixtures}/valid/bank`)[MODEL_DOC]!
    expect(validate(text)).toEqual([])
  })

  it.each(['duplicate_name', 'reserved_name', 'invalid_default', 'invalid_constraint'])(
    'reports %s at the fixture pointers', expectFixtureDiagnostic,
  )
})

describe('FR-DM-05: relations and references', () => {
  it.each(['dangling_reference', 'unmatched_relation'])('reports %s at the fixture pointers', expectFixtureDiagnostic)

  it('names the missing inverse and gives it a guarded setRelation fix', () => {
    const text = readFixture(`${fixtures}/invalid/unmatched_relation`)[MODEL_DOC]!
    const [diagnostic] = validate(text)
    expect(diagnostic?.hint?.ops).toEqual([{
      op: 'setRelation', doc: MODEL_DOC, baseRev: revOfText(text), entity: 'Account',
      relation: { name: 'customer', kind: 'belongsTo', to: 'Customer', foreignKey: 'customerId' },
    }])
  })

  it('accepts self-relations and derives each foreign key from its target, including mixed key types', () => {
    const text = readFixture(`${fixtures}/valid/bank`)[MODEL_DOC]!
    const model = modelSchema.parse(JSON.parse(text))
    const [customer, account, transaction] = model.entities
    customer!.relations.push(
      { name: 'parent', kind: 'belongsTo', to: 'Customer', foreignKey: 'parentId' },
      { name: 'children', kind: 'hasMany', to: 'Customer', foreignKey: 'parentId' },
    )
    const entities = new Map(model.entities.map((entity) => [entity.name, entity]))
    expect(modelFieldTypes(customer!, entities).get('parentId')).toBe('uuid')
    expect(modelFieldTypes(account!, entities).get('customerId')).toBe('uuid')
    expect(modelFieldTypes(transaction!, entities).get('accountId')).toBe('int')
    expect(validate(JSON.stringify(model))).toEqual([])
  })

  it('refuses a declared foreign key field and setNull on a required foreign key', () => {
    const text = readFixture(`${fixtures}/valid/bank`)[MODEL_DOC]!
    const model = modelSchema.parse(JSON.parse(text))
    const account = model.entities[1]!
    account.fields.push({ name: 'customerId', type: 'int' })
    account.relations[0] = {
      name: 'customer', kind: 'belongsTo', to: 'Customer', foreignKey: 'customerId', required: true, onDelete: 'setNull',
    }
    expect(validate(JSON.stringify(model))).toMatchObject([
      { code: 'invalid_constraint', pointer: '/entities/1/relations/0/foreignKey', message: expect.stringContaining('uuid') },
      { code: 'invalid_constraint', pointer: '/entities/1/relations/0/onDelete' },
    ])
  })

  it('offers to remove a declared field that a belongsTo relation already implies (spec 011 T012)', () => {
    // Both agent sessions of the MVP exercise declared customerId and the relation that implies it.
    const text = readFixture(`${fixtures}/valid/bank`)[MODEL_DOC]!
    const model = modelSchema.parse(JSON.parse(text))
    model.entities[1]!.fields.push({ name: 'customerId', type: 'uuid', required: true })
    const baseRev = rev(model)
    const [finding] = validateModel(model, baseRev)
    expect(finding).toMatchObject({
      code: 'invalid_constraint', pointer: '/entities/1/relations/0/foreignKey',
      message: expect.stringContaining('the relation declares it'),
      hint: { ops: [{ op: 'removeField', doc: MODEL_DOC, baseRev, entity: 'Account', field: 'customerId' }] },
    })
    const repaired = modelSchema.parse(JSON.parse(text))
    expect(validateModel(repaired, rev(repaired))).toEqual([])
  })
})

describe('FR-DM-06: model API fields and routes', () => {
  it('reports unsupported field types, conflicting paths and reused plurals', () => {
    expectFixtureDiagnostic('invalid_api')
  })

  it('accepts key and foreign-key filters and distinguishes methods, literals and disabled CRUD routes', () => {
    const text = readFixture(`${fixtures}/valid/bank`)[MODEL_DOC]!
    const model = modelSchema.parse(JSON.parse(text))
    model.entities[0]!.api.custom!.push({ name: 'exportCustomers', method: 'GET', path: 'export' })
    model.entities[1]!.api = {
      operations: ['list'],
      filterable: ['id', 'customerId'],
      sortable: ['customerId', 'frozen'],
      searchable: ['accountNumber'],
      custom: [
        { name: 'getByKey', method: 'GET', path: '{accountKey}' },
        { name: 'exportAccounts', method: 'GET', path: 'export' },
        { name: 'auditByKey', method: 'POST', path: '{accountKey}' },
      ],
    }
    expect(validate(JSON.stringify(model))).toEqual([])
  })

  it('refuses a model op that adds a conflicting custom route', () => {
    const text = readFixture(`${fixtures}/valid/bank`)[MODEL_DOC]!
    const outcome = apply(loadBlueprint({ [MODEL_DOC]: text }), [{
      op: 'setEntityApi', doc: MODEL_DOC, baseRev: revOfText(text), entity: 'Customer',
      api: { operations: ['list'], custom: [{ name: 'findCustomers', method: 'GET', path: '' }] },
    }], { ids: sequenceSource() })
    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid_result', details: {
      diagnostics: [{ code: 'invalid_api', pointer: '/entities/0/api/custom/0/path' }],
    } } })
  })
})
