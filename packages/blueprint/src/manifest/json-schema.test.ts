import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { manifestsToJsonSchema } from './json-schema.js'
import { resolveManifests } from './resolve.js'
import { componentManifestSchema, type ComponentSchema } from './types.js'

const components: ComponentSchema[] = JSON.parse(readFileSync(join(FIXTURES, 'manifests/analyzer/refine-admin.components.json'), 'utf8'))
const kit = Object.values(readFixture(join(FIXTURES, 'manifests/kit-sample')))
  .map((text) => componentManifestSchema.parse(JSON.parse(text)))
const { manifests } = resolveManifests({ kit, components })
const sample = { div: manifests.div, Input: manifests.Input, Card: manifests.Card, Button: manifests.Button }

it('FR-MF-07: snapshots schemas and discovery metadata for installed and missing types', () => {
  expect(manifestsToJsonSchema(sample)).toMatchSnapshot()
})

it('FR-MF-07: generated schemas enforce prop kinds and accept text and exposed values', () => {
  const { schemas, index } = manifestsToJsonSchema(sample)
  const ajv = new Ajv2020({ strict: true })

  const validateButton = ajv.compile(schemas.Button!)
  expect(validateButton({ variant: 'outline', children: 'Save' })).toBe(true)
  expect(validateButton({ variant: 'brand' })).toBe(false)
  expect(validateButton({ children: 123 })).toBe(false)
  expect(validateButton({ unrelated: true })).toBe(false)

  const validateInput = ajv.compile(schemas.Input!)
  expect(validateInput({ value: 'Search' })).toBe(true)
  expect(validateInput({ value: false })).toBe(false)
  expect(index.find(({ type }) => type === 'Input')).toMatchObject({
    installed: true,
    events: [{ name: 'onChange', prop: 'onChange' }],
    exposes: [{ name: 'value', type: 'string' }],
  })
  expect(index.find(({ type }) => type === 'Card')?.installed).toBe(false)
})
