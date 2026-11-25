import { compareBytes } from '../serialize.js'
import type { Diagnostic } from '../types/diagnostics.js'
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

export function resolveManifests({ kit, overrides = [], components, aliases }: ManifestInputs): ManifestResolution {
  const selected = new Map([...kit, ...overrides].map((manifest) => [manifest.type, manifest]))
  const manifests: Array<[string, ResolvedManifest]> = []
  const ui = aliases?.ui?.replace(/\/+$/, '')
  for (const type of [...selected.keys()].sort(compareBytes)) {
    const { variants: _, ...manifest } = selected.get(type)!
    const { source } = manifest
    const component = components.find(({ name }) => name === source.import.name)
    if (!component) continue
    const from = source.import.from === 'ui'
      ? (ui ? `${ui}/${source.item}` : component.importSource)
      : source.import.from
    manifests.push([type, {
      ...manifest,
      source: { ...source, import: { ...source.import, from } },
      props: component.props,
      installed: true,
    }])
  }
  return { manifests: Object.fromEntries(manifests), diagnostics: [] }
}
