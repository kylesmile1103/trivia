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

it('FR-MF-04: derives a manifest for the real Refine Admin data table', () => {
  const analyzed = components.find(({ name }) => name === 'DataTable')
  expect(analyzed).toBeDefined()
  const { manifests } = resolveManifests({ kit, components })
  expect(manifests.DataTable).toMatchObject({
    type: 'DataTable', installed: true,
    source: { registry: 'local', import: { name: 'DataTable', from: analyzed?.importSource } },
    props: analyzed?.props, events: [], exposes: [], client: false,
  })
})

it('FR-MF-04: derives slots and recognized DOM events for a local component', () => {
  const statCard: ComponentSchema = {
    name: 'StatCard', file: 'src/cards/stat-card.tsx', importSource: '~cards/stat-card',
    baseElement: 'section', acceptsChildren: true,
    props: [
      { name: 'title', kind: 'string', source: 'declared', optional: false },
      { name: 'onClick', kind: 'unknown', typeText: 'React.MouseEventHandler<HTMLElement>', source: 'declared', optional: true },
      { name: 'onCustom', kind: 'unknown', typeText: '() => void', source: 'declared', optional: true },
    ],
  }
  const { manifests } = resolveManifests({ kit: [], components: [statCard] })
  expect(manifests.StatCard).toMatchObject({
    type: 'StatCard', installed: true, props: statCard.props,
    source: { registry: 'local', import: { name: 'StatCard', from: '~cards/stat-card' } },
    slots: [{ name: 'children', kind: 'nodes' }],
    events: [{ name: 'onClick', prop: 'onClick' }],
    exposes: [], client: true, template: {},
  })
  const voidCard = resolveManifests({ kit: [], components: [{ ...statCard, acceptsChildren: false, props: [] }] })
  expect(voidCard.manifests.StatCard).toMatchObject({ slots: [], events: [], client: false })
})

it('FR-MF-05: uses the project override file and reports stale prop annotations', () => {
  const file = 'manifests/StatCard.manifest.json'
  const override = componentManifestSchema.parse(JSON.parse(
    readFileSync(join(FIXTURES, 'manifests/overrides/blueprint', file), 'utf8'),
  ))
  const analyzed: ComponentSchema = {
    name: 'StatCard', file: 'src/cards/stat-card.tsx', importSource: '~cards/stat-card',
    baseElement: 'section', acceptsChildren: true,
    props: [
      { name: 'count', kind: 'number', source: 'declared', optional: false },
      { name: 'onActivate', kind: 'unknown', typeText: '() => void', source: 'declared', optional: true },
    ],
  }
  const { manifests, diagnostics } = resolveManifests({ kit, overrides: [override], components: [analyzed] })
  expect(manifests.StatCard?.slots).toEqual(override.slots)
  expect(manifests.StatCard?.events).toEqual(override.events)
  expect(manifests.StatCard?.props).toEqual(analyzed.props)
  expect(manifests.StatCard?.propDescriptions).toEqual({ count: 'The number of matching items.' })
  expect(diagnostics).toMatchObject([{
    code: 'override_prop_missing', severity: 'warning', doc: file, pointer: '/props/1/name',
    message: expect.stringContaining('retired'),
  }])
})

it('FR-MF-06: reserves lowercase types for the curated intrinsics', () => {
  const misleading = { ...button, type: 'div' }
  const result = resolveManifests({ kit: [], overrides: [misleading], components })
  expect(result.manifests.div).toMatchObject({
    installed: true,
    source: { import: { name: 'div', from: '' } },
    slots: [{ name: 'children', kind: 'nodes' }],
  })
  expect(result.diagnostics).toEqual([])
})

it('uses analyzer imports with no components.json, and derives ui from the components alias', () => {
  const analyzed = components.find(({ name }) => name === 'Button')!
  expect(resolveManifests({ kit: [button], components: [analyzed] }).manifests.Button?.source.import.from)
    .toBe(analyzed.importSource)
  expect(resolveManifests({ kit: [button], components: [analyzed], aliases: { components: '~components/' } })
    .manifests.Button?.source.import.from).toBe('~components/ui/button')
})

it('selects the declared module among duplicate exports and rejects unresolved ambiguity', () => {
  const original = components.find(({ name }) => name === 'Button')!
  const duplicate = { ...original, file: 'src/other/button.tsx', importSource: '~other/button', props: [] }
  const candidates = [duplicate, original]
  const aliased = resolveManifests({ kit: [button], components: candidates, aliases: { ui: '@/components/ui' } })
  expect(aliased.diagnostics).toEqual([])
  expect(aliased.manifests.Button?.props).toEqual(original.props)
  const override = { ...button, source: { ...button.source, import: { name: 'Button', from: '~other/button' } }, props: [] }
  const explicit = resolveManifests({ kit: [button], overrides: [override], components: candidates })
  expect(explicit.manifests.Button?.props).toEqual([])
  expect(explicit.manifests.Button?.source.import.from).toBe('~other/button')

  for (const kit of [[], [button]]) {
    const ambiguous = resolveManifests({ kit, components: candidates })
    expect(ambiguous.manifests.Button).toBeUndefined()
    expect(ambiguous.diagnostics).toMatchObject([{
      code: 'ambiguous_component', severity: 'error',
      message: expect.stringContaining('src/components/ui/button.tsx, src/other/button.tsx'),
      hint: { text: expect.stringContaining('blueprint/manifests/Button.manifest.json') },
    }])
    expect(resolveManifests({ kit, components: [...candidates].reverse() })).toEqual(ambiguous)
  }
})

it('selects the exact Base UI style and uses the Radix fallback for other styles', () => {
  const sliders: Record<string, ComponentSchema[]> = JSON.parse(
    readFileSync(join(FIXTURES, 'manifests/analyzer/shadcn-4.21.3.slider.components.json'), 'utf8'),
  )
  // shadcn@4.21.3: Slider spreads the props of the underlying Radix or Base UI Root.
  const sliderManifest = componentManifestSchema.parse({
    type: 'Slider',
    source: { registry: 'shadcn', item: 'slider', import: { name: 'Slider', from: 'ui' } },
    props: [],
    slots: [],
    events: [{ name: 'onValueCommit', prop: 'onValueCommit', payload: 'number[]' }],
    exposes: [],
    client: true,
    template: {},
    variants: {
      'base-nova': {
        events: [{ name: 'onValueCommit', prop: 'onValueCommitted', payload: 'number | number[]' }],
      },
    },
  })
  const base = resolveManifests({ kit: [sliderManifest], components: sliders['base-nova']!, aliases: { style: 'base-nova' } })
    .manifests.Slider
  expect(base?.props).toEqual(sliders['base-nova']?.[0]?.props)
  expect(base?.events).toEqual(sliderManifest.variants?.['base-nova']?.events)
  expect(base).not.toHaveProperty('variants')
  for (const style of ['radix-nova', 'base-vega']) {
    const resolved = resolveManifests({ kit: [sliderManifest], components: sliders['radix-nova']!, aliases: { style } })
    expect(resolved.manifests.Slider?.events).toEqual(sliderManifest.events)
  }
})

it('FR-KT-01 resolves kit exports installed under a different filename', () => {
  const original = components.find(({ name }) => name === 'Button')!
  const renamed = { ...original, file: 'src/components/ui/action.tsx', importSource: '@/components/ui/action' }
  const { manifests } = resolveManifests({ kit: [button], components: [renamed], aliases: { ui: '@/components/ui' } })
  expect(manifests.Button?.source.import.from).toBe('@/components/ui/action')
})
