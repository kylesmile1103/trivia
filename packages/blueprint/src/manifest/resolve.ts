import type { Diagnostic } from '../types/diagnostics.js'
import type { ComponentManifest, ComponentSchema } from './types.js'

export type ResolvedManifest = Omit<ComponentManifest, 'variants'> & { installed: boolean }
export type ResolvedManifests = Readonly<Partial<Record<string, ResolvedManifest>>>

export interface ManifestInputs {
  kit: readonly ComponentManifest[]
  components: readonly ComponentSchema[]
}

export interface ManifestResolution {
  manifests: ResolvedManifests
  diagnostics: Diagnostic[]
}

export function resolveManifests({ kit, components }: ManifestInputs): ManifestResolution {
  const manifests: Array<[string, ResolvedManifest]> = []
  for (const { variants: _, ...manifest } of kit) {
    const component = components.find(({ name }) => name === manifest.source.import.name)
    if (component) manifests.push([manifest.type, { ...manifest, props: component.props, installed: true }])
  }
  return { manifests: Object.fromEntries(manifests), diagnostics: [] }
}
