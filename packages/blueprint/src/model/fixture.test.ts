import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'

function bankFixture(): string {
  const text = readFixture(`${FIXTURES}/model/valid/bank`)['model.blueprint.json']
  if (text === undefined) throw new Error('Missing bank model fixture')
  return text
}

describe('FR-DM-01, FR-DM-02, FR-DM-05, FR-DM-06: bank model fixture', () => {
  it('declares ordered bank entities, every type and constraint, both relation kinds and one custom operation', () => {
    const model = JSON.parse(bankFixture())
    expect(model.enums.map((entry: { name: string }) => entry.name)).toEqual(['CustomerStatus'])
    expect(model.entities.map((entry: { name: string }) => entry.name)).toEqual(['Customer', 'Account', 'Transaction'])
    const fields = model.entities.flatMap((entry: { fields: unknown[] }) => entry.fields)
    expect(new Set(fields.map((field: { type: string }) => field.type))).toEqual(new Set([
      'string', 'text', 'int', 'long', 'decimal', 'bool', 'date', 'datetime', 'uuid', 'enum', 'json',
    ]))
    expect(new Set(fields.flatMap((field: object) => Object.keys(field)))).toEqual(new Set([
      'name', 'type', 'enum', 'required', 'unique', 'readOnly', 'default', 'description',
      'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'precision', 'scale', 'generated',
    ]))
    const relations = model.entities.flatMap((entry: { relations: unknown[] }) => entry.relations)
    expect(new Set(relations.map((relation: { kind: string }) => relation.kind))).toEqual(new Set(['hasMany', 'belongsTo']))
    expect(model.entities.flatMap((entry: { api: { custom?: unknown[] } }) => entry.api.custom ?? []))
      .toMatchObject([{ name: 'approveKyc', method: 'POST', path: '{id}/approve-kyc', returns: 'Customer' }])
  })
})
