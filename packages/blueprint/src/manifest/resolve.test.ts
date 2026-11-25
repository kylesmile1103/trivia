import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { resolveManifests } from './resolve.js'
import { componentManifestSchema, type ComponentSchema } from './types.js'

const components: ComponentSchema[] = JSON.parse(readFileSync(join(FIXTURES, 'manifests/analyzer/refine-admin.components.json'), 'utf8'))
const kit = Object.values(readFixture(join(FIXTURES, 'manifests/kit-sample')))
  .map((text) => componentManifestSchema.parse(JSON.parse(text)))
const button = kit.find(({ type }) => type === 'Button')!

it('FR-MF-02: takes every installed kit type’s props verbatim from the analyzer snapshot', () => {
  const { manifests, diagnostics } = resolveManifests({ kit, components })
  expect(diagnostics).toEqual([])
  for (const manifest of kit) {
    const component = components.find(({ name }) => manifest.source.import.name === name)
    if (component) {
      expect(manifests[manifest.type]?.installed).toBe(true)
      expect(manifests[manifest.type]?.props).toEqual(component.props)
    }
  }
})

it('FR-MF-02: uses the project’s brand variant and drops the removed kit option', () => {
  const analyzed = components.find(({ name }) => name === 'Button')!
  const projectsButton: ComponentSchema = {
    ...analyzed,
    props: analyzed.props.map((prop) => prop.name === 'variant' && prop.kind === 'enum'
      ? { ...prop, options: ['default', 'brand'], default: 'brand' }
      : prop),
  }
  const { manifests } = resolveManifests({ kit: [button], components: [projectsButton] })
  expect(manifests.Button?.props).toEqual(projectsButton.props)
  expect(manifests.Button?.props.find(({ name }) => name === 'variant'))
    .toMatchObject({ options: ['default', 'brand'], default: 'brand' })
  expect(manifests.Button?.events).toEqual(button.events)
})
