import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { MODEL_MAPPING, modelMappingJson } from './mapping.js'

describe('FR-DM-04, SC-001: the model type mapping contract', () => {
  it('regenerates the exact fixture consumed by the C# generator tests', () => {
    const fixture = new URL('../../fixtures/model/model-mapping.json', import.meta.url)
    expect(modelMappingJson()).toBe(fs.readFileSync(fixture, 'utf8'))
  })

  it('keeps length and precision placeholders and the enum schema reference', () => {
    expect(MODEL_MAPPING.string).toMatchObject({ postgres: 'varchar({maxLength})', postgresWithoutMaxLength: 'text' })
    expect(MODEL_MAPPING.decimal.postgres).toBe('numeric({precision},{scale})')
    expect(MODEL_MAPPING.long.openapi).toEqual({ type: 'integer', format: 'int64' })
    expect(MODEL_MAPPING.enum.openapi).toEqual({ $ref: '#/components/schemas/{enum}' })
  })
})
