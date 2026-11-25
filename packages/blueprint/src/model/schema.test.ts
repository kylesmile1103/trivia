import { readdirSync, readFileSync } from 'node:fs'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { jsonSchemas, MODEL_DOC, modelSchema, revOfText, validateModel } from '../index.js'

const fixtures = `${FIXTURES}/model`
const ajv = new Ajv2020({ strict: true, allErrors: true })
const schemas = jsonSchemas()
const schemaFile = new URL('../../schemas/model.v1.json', import.meta.url)

function fixturePaths(parent: string): string[] {
  return readdirSync(`${fixtures}/${parent}`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}/${MODEL_DOC}`)
}

describe('FR-DM-01, FR-DM-02, SC-003: published model JSON Schema', () => {
  it('publishes the same draft 2020-12 schema that the build generates', () => {
    expect(schemas).toHaveProperty('model')
    expect(readFileSync(schemaFile, 'utf8')).toBe(JSON.stringify(schemas.model, null, 2) + '\n')
  })

  it('agrees with zod over every model fixture with ajv in strict mode', () => {
    const validate = ajv.compile(JSON.parse(readFileSync(schemaFile, 'utf8')))
    const documents = Object.entries(readFixture(fixtures)).filter(([file]) => file.endsWith(`/${MODEL_DOC}`))
    expect(documents.map(([file]) => file).sort()).toEqual([...fixturePaths('valid'), ...fixturePaths('invalid')].sort())
    for (const [file, text] of documents) {
      const value: unknown = JSON.parse(text)
      const allowed = !file.startsWith('invalid/schema_violation/')
      expect(validate(value), `${file}: ${ajv.errorsText(validate.errors)}`).toBe(allowed)
      expect(modelSchema.safeParse(value).success, file).toBe(allowed)
    }
  })

  it('points at missing decimal precision and at constraints on the wrong type', () => {
    const dir = `${fixtures}/invalid/schema_violation`
    const text = readFixture(dir)[MODEL_DOC]!
    const expected = JSON.parse(readFileSync(`${dir}/expected.json`, 'utf8'))
    expect(validateModel(JSON.parse(text), revOfText(text))).toMatchObject(expected.map((finding: object) => ({
      code: 'schema_violation', severity: 'error', doc: MODEL_DOC, ...finding,
    })))
  })
})
