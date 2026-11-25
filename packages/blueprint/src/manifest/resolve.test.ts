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

it('FR-MF-02: resolves kit imports using the project’s ui alias and keeps explicit imports', () => {
  const input = kit.find(({ type }) => type === 'Input')!
  const explicit = { ...input, source: { ...input.source, import: { name: 'Input', from: '~forms/input' } } }
  const { manifests } = resolveManifests({
    kit: [button, explicit], components, aliases: { ui: '~design/' },
  })
  expect(manifests.Button?.source.import).toEqual({ name: 'Button', from: '~design/button' })
  expect(manifests.Input?.source.import).toEqual({ name: 'Input', from: '~forms/input' })
  expect(button.source.import.from).toBe('ui')
})

it('FR-MF-05: picks override metadata before taking the analyzer’s props', () => {
  const override = { ...button, props: [], slots: [{ name: 'label', kind: 'text' as const }] }
  const inputs = {
    kit, overrides: [override], components, aliases: { ui: '~design' },
  }
  const result = resolveManifests(inputs)
  expect(result.manifests.Button?.slots).toEqual(override.slots)
  expect(result.manifests.Button?.props).toEqual(components.find(({ name }) => name === 'Button')?.props)
  expect(JSON.stringify(resolveManifests(structuredClone(inputs)))).toBe(JSON.stringify(result))
})

it('FR-MF-03: retains missing kit entries and their registry metadata', () => {
  const select = {
    ...button, type: 'Select',
    source: { registry: 'shadcn' as const, item: 'select', import: { name: 'Select', from: 'ui' } },
  }
  const { manifests, diagnostics } = resolveManifests({ kit: [select], components: [], aliases: { ui: '~design' } })
  expect(diagnostics).toEqual([])
  expect(manifests.Select).toMatchObject({
    installed: false, props: select.props,
    source: { registry: 'shadcn', item: 'select', import: { name: 'Select', from: '~design/select' } },
  })
})
