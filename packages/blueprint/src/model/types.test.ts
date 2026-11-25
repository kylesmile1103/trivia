import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { serialize } from '../serialize.js'
import { fieldSchema, keySchema, modelSchema, relationSchema } from './types.js'

function reverseProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseProperties)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseProperties(child)]))
  }
  return value
}

describe('FR-DM-01, FR-DM-02: the model v1 schema', () => {
  it('parses and canonically round-trips the bank fixture, keeping every declared array order', () => {
    const text = readFixture(`${FIXTURES}/model/valid/bank`)['model.blueprint.json']!
    const value: unknown = JSON.parse(text)
    expect(serialize(modelSchema.parse(reverseProperties(value)))).toBe(text)
  })

  it.each([
    { name: 'balance', type: 'decimal' },
    { name: 'balance', type: 'decimal', precision: 0, scale: 0 },
    { name: 'balance', type: 'decimal', precision: 18, scale: -1 },
    { name: 'balance', type: 'int', maxLength: 5 },
    { name: 'balance', type: 'long', minimum: 0.5 },
    { name: 'reviewAt', type: 'date', generated: 'onCreate' },
    { name: 'reviewAt', type: 'enum' },
    { name: 'FirstName', type: 'string' },
    { name: 'first_name', type: 'string' },
  ])('refuses an invalid field shape %j', (field) => {
    expect(fieldSchema.safeParse(field).success).toBe(false)
  })

  it('accepts a camelCase keyword for the reserved-name pass to diagnose', () => {
    expect(fieldSchema.safeParse({ name: 'class', type: 'string' }).success).toBe(true)
  })

  it('rejects composite keys, non-key types and onDelete on a hasMany relation', () => {
    expect(keySchema.safeParse([{ name: 'id', type: 'uuid' }]).success).toBe(false)
    expect(keySchema.safeParse({ name: 'id', type: 'string' }).success).toBe(false)
    expect(keySchema.safeParse({ name: 'id', type: 'int', generated: 'v7' }).success).toBe(false)
    expect(relationSchema.safeParse({
      name: 'children', kind: 'hasMany', to: 'Child', foreignKey: 'parentId', onDelete: 'cascade',
    }).success).toBe(false)
  })
})
