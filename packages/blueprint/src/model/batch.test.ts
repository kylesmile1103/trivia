import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { apply, blueprintOpSchema, loadBlueprint, MODEL_DOC, OP_NAMES, revOfText, sequenceSource } from '../index.js'
import { modelOpSchema } from './apply.js'

const fixtures = `${FIXTURES}/model`
const bank = readFixture(`${fixtures}/valid/bank`)[MODEL_DOC]!
const options = { ids: sequenceSource() }
const modelOp = { doc: MODEL_DOC, baseRev: revOfText(bank) }

describe('FR-DM-07: model operations through the public batch reducer', () => {
  it('includes every model op in the advertised union and creates a guarded model', () => {
    expect(OP_NAMES).toEqual(expect.arrayContaining(modelOpSchema.options.map((schema) => schema.shape.op.value)))
    const op = { op: 'setModel', doc: MODEL_DOC, baseRev: null, namespace: 'Bank' }
    expect(blueprintOpSchema.safeParse(op).success).toBe(true)
    const outcome = apply(loadBlueprint({}, { exists: false }), [op], options)
    expect(outcome.ok && outcome.writes).toEqual([{
      file: MODEL_DOC, before: null,
      after: JSON.stringify({
        $schema: 'https://trivia.dev/schemas/blueprint/model.v1.json',
        blueprintVersion: 1, namespace: 'Bank', enums: [], entities: [],
      }, null, 2) + '\n',
    }])
  })

  it('requires the model path and an explicit base revision', () => {
    expect(blueprintOpSchema.safeParse({ op: 'setModel', doc: MODEL_DOC, namespace: 'Bank' }).success).toBe(false)
    expect(blueprintOpSchema.safeParse({
      op: 'setModel', doc: 'pages/Bank.page.json', baseRev: null, namespace: 'Bank',
    }).success).toBe(false)
  })

  it('refuses a stale model rev before any page or model writes', () => {
    const files = readFixture(`${FIXTURES}/valid/backoffice`)
    const blueprint = loadBlueprint({ ...files, [MODEL_DOC]: bank })
    const page = 'pages/CustomerList.page.json'
    const before = JSON.stringify(blueprint)
    const stale = 'sha256:' + '0'.repeat(64)
    const outcome = apply(blueprint, [
      { op: 'setPageMeta', doc: page, baseRev: blueprint.docs[page]?.rev, public: true },
      { ...modelOp, op: 'renameEntity', entity: 'Customer', name: 'Client', baseRev: stale },
    ], options)
    expect(outcome).toMatchObject({
      ok: false, error: {
        code: 'conflict', status: 409, op: 1,
        details: { doc: MODEL_DOC, expected: stale, actual: modelOp.baseRev, revs: {
          [page]: blueprint.docs[page]?.rev, [MODEL_DOC]: modelOp.baseRev,
        } },
      },
    })
    expect(outcome).not.toHaveProperty('writes')
    expect(JSON.stringify(blueprint)).toBe(before)
  })

  it('refuses an entity removal with the inbound relation names', () => {
    const outcome = apply(loadBlueprint({ [MODEL_DOC]: bank }), [
      { ...modelOp, op: 'removeEntity', entity: 'Customer' },
    ], options)
    expect(outcome).toMatchObject({
      ok: false, error: {
        code: 'invalid_result', status: 422, op: 0, details: {
          references: ['Account.customer', 'Transaction.reviewer'],
        },
      },
    })
    expect(outcome).not.toHaveProperty('writes')
  })

  it('refuses a newly dangling index, and accepts a batch that repairs it', () => {
    const blueprint = loadBlueprint({ [MODEL_DOC]: bank })
    const remove = { ...modelOp, op: 'removeField', entity: 'Customer', field: 'status' }
    const refused = apply(blueprint, [remove], options)
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_result', details: {
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'dangling_reference', pointer: '/entities/0/indexes/0/fields/0' }),
        expect.objectContaining({ code: 'dangling_reference', pointer: '/entities/0/api/filterable/0' }),
      ]),
    } } })
    expect(refused).not.toHaveProperty('writes')
    const repaired = apply(blueprint, [
      remove,
      { ...modelOp, op: 'setIndexes', entity: 'Customer', indexes: [] },
      { ...modelOp, op: 'setEntityApi', entity: 'Customer', api: { operations: ['list'], filterable: ['email'] } },
    ], options)
    expect(repaired.ok && repaired.result.diagnostics).toEqual([])
  })

  it('reports pre-existing findings without blocking changes and can apply their fixing ops', () => {
    const broken = readFixture(`${fixtures}/invalid/unmatched_relation`)[MODEL_DOC]!
    const result = apply(loadBlueprint({ [MODEL_DOC]: broken }), [
      { op: 'setModel', doc: MODEL_DOC, baseRev: revOfText(broken), namespace: 'Finance' },
    ], options)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [finding] = result.result.diagnostics
    expect(finding?.code).toBe('unmatched_relation')
    expect(finding?.hint?.ops?.[0]?.baseRev).toBe(result.result.revs[MODEL_DOC])
    const repaired = apply(result.blueprint, finding?.hint?.ops ?? [], options)
    expect(repaired.ok && repaired.result.diagnostics).toEqual([])
    expect(repaired.ok && repaired.writes).toHaveLength(1)
  })
})
