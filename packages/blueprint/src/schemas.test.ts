import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../test/helpers.js'
import { jsonSchemas } from './schemas.js'
import { kindOf } from './store.js'
import { EXPRESSION_META } from './types/common.js'
import { checkSchema } from './validate/schema.js'

const schemas = jsonSchemas()
const ajv = new Ajv2020({ strict: true, allErrors: true })
ajv.addKeyword({ keyword: EXPRESSION_META, schemaType: 'boolean' })
const validators = { app: ajv.compile(schemas.app), page: ajv.compile(schemas.page) }

function fixtureDirs(parent: string): string[] {
  return readdirSync(path.join(FIXTURES, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`)
    .sort()
}

function expectFixture(dir: string, valid: boolean): void {
  const files = Object.entries(readFixture(path.join(FIXTURES, dir)))
  expect(files.length, dir).toBeGreaterThan(0)
  for (const [file, text] of files) {
    const label = `${dir}/${file}`
    const kind = kindOf(file)
    if (kind !== 'app' && kind !== 'page') throw new Error(`No published schema for ${label}`)

    const value: unknown = JSON.parse(text)
    // Layer 1 also rejects keys that Zod would silently drop.
    const layer1Valid = checkSchema(kind, value, file).doc !== null
    const validate = validators[kind]
    const ajvValid = validate(value)
    expect(ajvValid, `${label} (layer 1 accepted: ${layer1Valid})\n${ajv.errorsText(validate.errors)}`).toBe(valid)
    expect(layer1Valid, label).toBe(valid)
  }
}

describe('published JSON Schemas', () => {
  it.each(Object.entries(schemas))('%s matches the generated schema', (kind, schema) => {
    const file = new URL(`../schemas/${kind}.v1.json`, import.meta.url)
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(schema, null, 2) + '\n')
  })

  it.each([...fixtureDirs('valid'), 'migrate/v1'])('accepts every document in %s', (dir) => {
    expectFixture(dir, true)
  })

  it.each(fixtureDirs('invalid/schema_violation'))('rejects every document in %s', (dir) => {
    expectFixture(dir, false)
  })
})
