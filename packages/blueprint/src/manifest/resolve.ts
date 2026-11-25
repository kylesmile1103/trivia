import { compareBytes } from '../serialize.js'
import type { Diagnostic } from '../types/diagnostics.js'
import { PAGE_NAME } from '../types/common.js'
import { INTRINSIC_EVENT_NAMES } from './intrinsics.js'
import type { ComponentManifest, ComponentSchema } from './types.js'

export type ResolvedManifest = Omit<ComponentManifest, 'variants'> & { installed: boolean }
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

export function resolveManifests({ kit, overrides = [], components, aliases }: ManifestInputs): ManifestResolution {
  const selected = new Map([...kit, ...overrides].map((manifest) => [manifest.type, manifest]))
  const manifests: Array<[string, ResolvedManifest]> = []
  const ui = aliases?.ui?.replace(/\/+$/, '')
  for (const type of [...selected.keys()].sort(compareBytes)) {
    const { variants: _, ...manifest } = selected.get(type)!
    const { source } = manifest
    const component = components.find(({ name }) => name === source.import.name)
    const from = source.import.from === 'ui'
      ? (ui ? `${ui}/${source.item}` : (component?.importSource ?? 'ui'))
      : source.import.from
    manifests.push([type, {
      ...manifest,
      source: { ...source, import: { ...source.import, from } },
      props: component?.props ?? manifest.props,
      installed: component !== undefined,
    }])
  }
  for (const component of components) {
    if (PAGE_NAME.test(component.name) && !selected.has(component.name)) {
      manifests.push([component.name, derive(component)])
    }
  }
  return { manifests: Object.fromEntries(manifests.sort(([a], [b]) => compareBytes(a, b))), diagnostics: [] }
}
