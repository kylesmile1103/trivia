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

export interface ManifestAliases {
  ui?: string
  components?: string
  style?: string
}

export interface ManifestInputs {
  kit: readonly ComponentManifest[]
  overrides?: readonly ComponentManifest[]
  aliases?: ManifestAliases
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

type Variant = NonNullable<ComponentManifest['variants']>[string]

function inspectOverride(
  manifest: Omit<ComponentManifest, 'variants'>,
  style: string | undefined,
  variant: Variant | undefined,
  known: ReadonlySet<string>,
  diagnostics: Diagnostic[],
): void {
  const report = (prop: string, field: 'props' | 'events' | 'exposes', ...path: PropertyKey[]) => {
    if (known.has(prop)) return
    const prefix = style !== undefined && variant?.[field] !== undefined ? ['variants', style] : []
    diagnostics.push({
      code: 'override_prop_missing',
      severity: 'warning',
      doc: `manifests/${manifest.type}.manifest.json`,
      pointer: toPointer([...prefix, field, ...path]),
      message: `The analyzer found no prop "${prop}" on ${manifest.source.import.name}`,
    })
  }
  manifest.props.forEach(({ name }, index) => report(name, 'props', index, 'name'))
  manifest.events.forEach(({ prop }, index) => report(prop, 'events', index, 'prop'))
  manifest.exposes.forEach(({ via }, index) => {
    report(via.valueProp, 'exposes', index, 'via', 'valueProp')
    report(via.changeProp, 'exposes', index, 'via', 'changeProp')
  })
}

function duplicateExport(type: string, name: string, candidates: ComponentSchema[]): Diagnostic {
  const files = [...new Set(candidates.map(({ file }) => file))].sort(compareBytes)
  return {
    code: 'ambiguous_component',
    severity: 'error',
    doc: '',
    pointer: '',
    message: `The export "${name}" for ${type} is ambiguous: ${files.join(', ')}`,
    hint: { text: `Set source.import.from to the intended module in blueprint/manifests/${type}.manifest.json.` },
  }
}

export function resolveManifests({ kit, overrides = [], components, aliases }: ManifestInputs): ManifestResolution {
  const selected = new Map([...kit, ...overrides].map((manifest) => [manifest.type, manifest]))
  const overrideTypes = new Set(overrides.map(({ type }) => type))
  const manifests: Array<[string, ResolvedManifest]> = structuredClone(intrinsicManifests)
    .map((manifest) => [manifest.type, { ...manifest, installed: true }])
  const diagnostics: Diagnostic[] = []
  const byName = new Map<string, ComponentSchema[]>()
  for (const component of components) {
    const candidates = byName.get(component.name)
    if (candidates) candidates.push(component)
    else byName.set(component.name, [component])
  }

  const componentsAlias = aliases?.components?.replace(/\/+$/, '')
  const ui = aliases?.ui?.replace(/\/+$/, '') || (componentsAlias ? `${componentsAlias}/ui` : undefined)
  const style = aliases?.style
  for (const [type, selectedManifest] of [...selected].sort(([a], [b]) => compareBytes(a, b))) {
    if (!PAGE_NAME.test(type)) continue
    const { variants, ...base } = selectedManifest
    const variant = style !== undefined && variants && Object.hasOwn(variants, style) ? variants[style] : undefined
    const replacements = Object.fromEntries(Object.entries(variant ?? {}).filter(([, value]) => value !== undefined))
    const manifest = { ...base, ...replacements }
    const { source } = manifest
    const { name } = source.import
    const declaredFrom = source.import.from === 'ui' ? (ui && `${ui}/${source.item}`) : source.import.from
    const candidates = byName.get(name) ?? []
    const matching = candidates.length > 1 ? candidates.filter(({ importSource }) => importSource === declaredFrom) : candidates
    if (candidates.length > 1 && matching.length !== 1) {
      diagnostics.push(duplicateExport(type, name, candidates))
      continue
    }
    const component = matching[0]
    const from = declaredFrom ?? component?.importSource ?? 'ui'
    const known = new Set(component?.props.map(({ name }) => name))
    if (component && overrideTypes.has(type)) inspectOverride(manifest, style, variant, known, diagnostics)
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
  for (const [name, candidates] of [...byName].sort(([a], [b]) => compareBytes(a, b))) {
    if (!PAGE_NAME.test(name) || selected.has(name)) continue
    if (candidates.length > 1) diagnostics.push(duplicateExport(name, name, candidates))
    else manifests.push([name, derive(candidates[0]!)])
  }
  return { manifests: Object.fromEntries(manifests.sort(([a], [b]) => compareBytes(a, b))), diagnostics }
}
