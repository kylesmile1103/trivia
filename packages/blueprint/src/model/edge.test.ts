import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import {
  apply, loadBlueprint, MODEL_DOC, modelFieldTypes, modelSchema, revOfText, sequenceSource, serialize, validateModel,
} from '../index.js'

function reviews(): string {
  const text = readFixture(`${FIXTURES}/model/valid/reviews`)[MODEL_DOC]
  if (text === undefined) throw new Error('Missing reviews model fixture')
  return text
}

describe('FR-DM-02 and FR-DM-05: enum wire values, self-relations and mixed keys', () => {
  it('preserves enum wire values that cannot be C# identifiers', () => {
    const text = reviews()
    const model = modelSchema.parse(JSON.parse(text))
    expect(model.enums[0]?.values).toEqual(['in-review', 'approved', '1st-review'])
    expect(model.entities[1]?.fields[0]).toMatchObject({ type: 'enum', default: 'in-review' })
    expect(validateModel(model, revOfText(text))).toEqual([])
    expect(serialize(model)).toBe(text)
  })

  it('preserves the inverse of a renamed self-relation and follows a target key type change', () => {
    const text = reviews()
    const model = modelSchema.parse(JSON.parse(text))
    const entities = new Map(model.entities.map((entity) => [entity.name, entity]))
    const original = modelFieldTypes(entities.get('ReviewCase')!, entities)
    expect([original.get('id'), original.get('parentCaseId'), original.get('queueId')]).toEqual(['uuid', 'uuid', 'int'])

    const guard = { doc: MODEL_DOC, baseRev: revOfText(text) }
    const outcome = apply(loadBlueprint({ [MODEL_DOC]: text }), [
      { ...guard, op: 'renameEntity', entity: 'ReviewCase', name: 'ReviewItem' },
      { ...guard, op: 'setEntity', entity: { name: 'ReviewQueue', key: { name: 'id', type: 'long' } } },
    ], { ids: sequenceSource() })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.diagnostics).toEqual([])
    const updated = modelSchema.parse(JSON.parse(outcome.writes[0]!.after!))
    const updatedEntities = new Map(updated.entities.map((entity) => [entity.name, entity]))
    const item = updatedEntities.get('ReviewItem')!
    expect(item.relations.map(({ kind, to, foreignKey }) => [kind, to, foreignKey])).toEqual([
      ['belongsTo', 'ReviewItem', 'parentCaseId'],
      ['hasMany', 'ReviewItem', 'parentCaseId'],
      ['belongsTo', 'ReviewQueue', 'queueId'],
    ])
    const fields = modelFieldTypes(item, updatedEntities)
    expect([fields.get('id'), fields.get('parentCaseId'), fields.get('queueId')]).toEqual(['uuid', 'uuid', 'long'])
    expect(updatedEntities.get('ReviewLog')?.relations[0]?.to).toBe('ReviewItem')
    expect(modelFieldTypes(updatedEntities.get('ReviewLog')!, updatedEntities).get('caseId')).toBe('uuid')
  })
})
