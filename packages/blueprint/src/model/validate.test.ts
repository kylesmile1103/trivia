import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { MODEL_DOC } from '../types/ops.js'
import { modelSchema } from './types.js'
import { validateModel } from './validate.js'

const fixtures = `${FIXTURES}/model`

describe('FR-DM-03: model names, constraints and defaults', () => {
  it('reports no findings for the bank model', () => {
    const text = readFixture(`${fixtures}/valid/bank`)[MODEL_DOC]!
    expect(validateModel(modelSchema.parse(JSON.parse(text)))).toEqual([])
  })

  it.each(['duplicate_name', 'reserved_name', 'invalid_default', 'invalid_constraint'])('reports %s at the fixture pointers', (code) => {
    const dir = `${fixtures}/invalid/${code}`
    const text = readFixture(dir)[MODEL_DOC]!
    const expected = JSON.parse(fs.readFileSync(`${dir}/expected.json`, 'utf8'))
    expect(validateModel(modelSchema.parse(JSON.parse(text)))).toMatchObject(expected.map((diagnostic: object) => ({
      code, severity: 'error', doc: MODEL_DOC, ...diagnostic,
    })))
  })
})
