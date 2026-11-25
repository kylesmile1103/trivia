import { join } from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { componentManifestSchema, manifestJsonSchema } from './types.js'

const kit = Object.values(readFixture(join(FIXTURES, 'manifests/kit-sample'))).map((text) => JSON.parse(text))
const variant = {
  events: [{ name: 'onChange', prop: 'onValueChange', payload: 'string' }],
  exposes: [{
    name: 'value', type: 'string', initial: '',
    via: { valueProp: 'value', changeProp: 'onValueChange', changeArg: 'value' },
  }],
}

it('FR-MF-01: parses the samples and supports partial metadata per shadcn style', () => {
  for (const manifest of kit) expect(componentManifestSchema.parse(manifest)).toEqual(manifest)
  const withVariant = { ...kit[1], variants: { 'base-nova': variant } }
  expect(componentManifestSchema.parse(withVariant)).toEqual(withVariant)
})

it('FR-MF-01: JSON Schema accepts the same sample manifests and rejects invalid metadata', () => {
  const validate = new Ajv2020({ strict: true }).compile(manifestJsonSchema())
  for (const manifest of kit) expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true)

  const examples = [
    { ...kit[0], props: [{ name: 'variant', kind: 'enum', optional: true, source: 'variant' }] },
    { ...kit[0], slots: [{ name: 'body', kind: 'element' }] },
    { ...kit[0], events: [{ name: 'click', prop: 'onClick' }] },
    { ...kit[0], variants: { 'base-nova': { type: 'Other' } } },
    { ...kit[0], exposes: [{ ...variant.exposes[0], via: { ...variant.exposes[0]?.via, changeArg: 'event' } }] },
  ]
  for (const manifest of examples) {
    expect(componentManifestSchema.safeParse(manifest).success).toBe(false)
    expect(validate(manifest)).toBe(false)
  }
})
