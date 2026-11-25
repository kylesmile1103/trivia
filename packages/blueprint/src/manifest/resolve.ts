import { compareBytes } from '../serialize.js'
import { toPointer, type Diagnostic } from '../types/diagnostics.js'
import { PAGE_NAME } from '../types/common.js'
import { INTRINSIC_EVENT_NAMES, intrinsicManifests } from './intrinsics.js'
import type { ComponentManifest, ComponentSchema } from './types.js'

export type ResolvedManifest = Omit<ComponentManifest, 'variants'> & {
  installed: boolean
  propDescriptions?: Record<string, string>
}
export type ResolvedManifests = Readonly<Partial<Record<string, ResolvedManifest>>>

export interface ManifestInputs {
  kit: readonly ComponentManifest[]
  overrides?: readonly ComponentManifest[]
  aliases?: { ui?: string }
  components: readonly ComponentSchema[]
}

export interface ManifestResolution {
  manifests: ResolvedManifests
  diagnostics: Diagnostic[]
}

function derive({ name, importSource, props, acceptsChildren }: ComponentSchema): ResolvedManifest {
  const events = props.filter(({ name }) => INTRINSIC_EVENT_NAMES.has(name))
    .map(({ name }) => ({ name, prop: name }))
  return {
    type: name,
    source: { registry: 'local', item: name, import: { name, from: importSource } },
    props,
    slots: acceptsChildren ? [{ name: 'children', kind: 'nodes' }] : [],
    events,
    exposes: [],
    client: events.length > 0,
    template: {},
    installed: true,
  }
}

function inspectOverride(
  manifest: Omit<ComponentManifest, 'variants'>,
  known: ReadonlySet<string>,
  diagnostics: Diagnostic[],
): void {
  const report = (prop: string, path: PropertyKey[]) => {
    if (known.has(prop)) return
    diagnostics.push({
      code: 'override_prop_missing',
      severity: 'warning',
      doc: `manifests/${manifest.type}.manifest.json`,
      pointer: toPointer(path),
      message: `The analyzer found no prop "${prop}" on ${manifest.source.import.name}`,
    })
  }
  manifest.props.forEach(({ name }, index) => report(name, ['props', index, 'name']))
  manifest.events.forEach(({ prop }, index) => report(prop, ['events', index, 'prop']))
  manifest.exposes.forEach(({ via }, index) => {
    report(via.valueProp, ['exposes', index, 'via', 'valueProp'])
    report(via.changeProp, ['exposes', index, 'via', 'changeProp'])
  })
}

export function resolveManifests({ kit, overrides = [], components, aliases }: ManifestInputs): ManifestResolution {
  const selected = new Map([...kit, ...overrides].map((manifest) => [manifest.type, manifest]))
  const overrideTypes = new Set(overrides.map(({ type }) => type))
  const manifests: Array<[string, ResolvedManifest]> = structuredClone(intrinsicManifests)
    .map((manifest) => [manifest.type, { ...manifest, installed: true }])
  const diagnostics: Diagnostic[] = []
  const ui = aliases?.ui?.replace(/\/+$/, '')
  for (const type of [...selected.keys()].sort(compareBytes)) {
    if (!PAGE_NAME.test(type)) continue
    const { variants: _, ...manifest } = selected.get(type)!
    const { source } = manifest
    const component = components.find(({ name }) => name === source.import.name)
    const from = source.import.from === 'ui'
      ? (ui ? `${ui}/${source.item}` : (component?.importSource ?? 'ui'))
      : source.import.from
    const known = new Set(component?.props.map(({ name }) => name))
    if (component && overrideTypes.has(type)) inspectOverride(manifest, known, diagnostics)
    const descriptions: Array<[string, string]> = []
    for (const { name, description } of manifest.props) {
      if (known.has(name) && description !== undefined) descriptions.push([name, description])
    }
    manifests.push([type, {
      ...manifest,
      source: { ...source, import: { ...source.import, from } },
      props: component?.props ?? manifest.props,
      installed: component !== undefined,
      ...(descriptions.length > 0 && { propDescriptions: Object.fromEntries(descriptions) }),
    }])
  }
  for (const component of components) {
    if (PAGE_NAME.test(component.name) && !selected.has(component.name)) {
      manifests.push([component.name, derive(component)])
    }
  }
  return { manifests: Object.fromEntries(manifests.sort(([a], [b]) => compareBytes(a, b))), diagnostics }
}
