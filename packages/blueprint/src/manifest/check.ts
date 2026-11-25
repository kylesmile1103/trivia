import { compareBytes } from '../serialize.js'
import type { Blueprint } from '../store.js'
import { toPointer, type Diagnostic } from '../types/diagnostics.js'
import type { CustomPage, PageDoc } from '../types/page.js'
import type { LayerCheck } from '../validate/context.js'
import type { ResolvedManifests } from './resolve.js'
import { configuredTabs, manifestProps, manifestSlots, type ComponentManifest, type PropSchema } from './types.js'

const deferredTypes = new Set([
  'Tree', 'TreeSelect', 'Cascader', 'Transfer', 'Upload', 'TimePicker', 'DateRangePicker', 'Steps', 'Rate', 'Tour', 'Chart',
])

const byKey = <T>(record: Record<string, T>) => Object.entries(record).sort(([a], [b]) => compareBytes(a, b))

const lookup = (manifests: ResolvedManifests, type: string) =>
  Object.hasOwn(manifests, type) ? manifests[type] : undefined

const describe = (names: readonly string[]) => names.length ? names.join(', ') : '(none)'

function invalidValue(prop: PropSchema, value: unknown): string | undefined {
  if (prop.kind === 'unknown') return
  if (prop.kind === 'enum') {
    if (typeof value !== 'string' || !prop.options.includes(value)) return describe(prop.options)
    return
  }
  const kind = prop.kind === 'className' ? 'string' : prop.kind
  if (typeof value !== kind) return kind
}

function installHint({ registry, item, import: specifier }: ComponentManifest['source']): string {
  if (registry === 'local') return `Restore the local export "${specifier.name}" from "${specifier.from}".`
  const target = registry === 'refine' && /^[a-z][a-z0-9-]*$/.test(item)
    ? `https://ui.refine.dev/r/${item}.json`
    : item
  const arg = /^[A-Za-z0-9@][A-Za-z0-9_@./:-]*$/.test(target)
    ? target
    : `-- '${target.replaceAll("'", "'\\''")}'`
  return `pnpm dlx shadcn@latest add ${arg}`
}

function checkPage(page: CustomPage, doc: string, manifests: ResolvedManifests, out: Diagnostic[]): void {
  const report = (code: string, path: string[], message: string, hint?: string) => {
    out.push({ code, doc, pointer: toPointer(path), message, severity: 'error', ...(hint && { hint: { text: hint } }) })
  }
  for (const [id, node] of byKey(page.nodes)) {
    const manifest = lookup(manifests, node.type)
    if (!manifest) {
      const hint = deferredTypes.has(node.type)
        ? `${node.type} is deferred in the kit. Use a local component with its own manifest.`
        : undefined
      report('unknown_component', ['nodes', id, 'type'], `Unknown component ${node.type}`, hint)
      continue
    }
    if (!manifest.installed) {
      const { source } = manifest
      report('missing_component', ['nodes', id, 'type'],
        `${node.type} is missing (${source.registry} item "${source.item}")`, installHint(source))
      continue
    }
    if (node.parent !== null && node.slot !== null) {
      const parent = page.nodes[node.parent]
      const parentManifest = parent && lookup(manifests, parent.type)
      if (parent && parentManifest?.installed) {
        const slots = manifestSlots(parentManifest, page.props[node.parent])
        const slot = slots.find(({ name }) => name === node.slot)
        const path = ['nodes', id, 'slot']
        if (!slot) {
          report('unknown_slot', path, `${parent.type} has no slot "${node.slot}". Available slots: ${describe(slots.map(({ name }) => name))}`)
        } else if (slot.kind === 'text') {
          report('invalid_slot_content', path, `${parent.type}.${slot.name} accepts text`)
        } else if (slot.accepts && !slot.accepts.includes(node.type)) {
          report('invalid_slot_content', path, `${parent.type}.${slot.name} accepts: ${describe(slot.accepts)}`)
        }
      }
    }

    const props = manifestProps(manifest)
    for (const map of ['props', 'bindings'] as const) {
      for (const [name, value] of byKey(page[map][id] ?? {})) {
        const path = [map, id, name]
        if (map === 'bindings' && manifest.exposes.some(({ via }) => via.changeProp === name)) {
          const event = manifest.events.find(({ prop }) => prop === name)?.name
          const hint = event === undefined ? 'Use an action on the change event.' : `Use an action at actions["${id}.${event}"].`
          report('controlled_change_binding', path, `The compiler owns ${node.type}.${name} for its exposed value`, hint)
          continue
        }
        if (map === 'bindings' && manifest.configuration?.some((prop) => prop.name === name)) {
          report('invalid_prop_value', path, `${node.type}.${name} is compile-time configuration and requires a static value`)
          continue
        }
        const prop = props.get(name)
        if (!prop) {
          report('unknown_prop', path, `${node.type} has no prop "${name}"`,
            `Check the component source and its blueprint/manifests/${node.type}.manifest.json override.`)
        } else if (map === 'props') {
          const expected = invalidValue(prop, value)
          if (expected) report('invalid_prop_value', path, `${node.type}.${name} expects ${expected}`)
          else if (node.type === 'Tabs' && name === 'tabs' && manifest.configuration?.some((prop) => prop.name === name) &&
            !configuredTabs(manifest, value)) {
            report('invalid_prop_value', path, 'Tabs.tabs expects { name, label } entries with unique slot names.')
          }
        }
      }
    }
  }
  for (const key of Object.keys(page.actions).sort(compareBytes)) {
    const dot = key.indexOf('.')
    const node = page.nodes[key.slice(0, dot)]
    const event = key.slice(dot + 1)
    const manifest = node && lookup(manifests, node.type)
    if (manifest?.installed && !manifest.events.some(({ name }) => name === event)) {
      report('unknown_event', ['actions', key],
        `${manifest.type} has no event "${event}". Available events: ${describe(manifest.events.map(({ name }) => name))}`)
    }
  }
}

/** Layer 3 checks for the custom pages that passed the earlier layers. */
export function checkManifests(blueprint: Blueprint, manifests: ResolvedManifests): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const [doc, entry] of byKey(blueprint.docs)) {
    if (entry.kind === 'page' && entry.doc?.kind === 'custom') checkPage(entry.doc, doc, manifests, out)
  }
  return out
}

/** Supply this check as `ctx.manifests` to validate() and to guarded ops. */
export function manifestCheck(manifests: ResolvedManifests): LayerCheck {
  return (blueprint) => checkManifests(blueprint, manifests)
}

export interface ExposedScope {
  tier: 'client'
  members: Record<string, string[]>
  types: Record<string, Record<string, string>>
}

/** The ui root for the expression compiler and the TypeScript types of its exposed values. */
export function exposedScope(page: PageDoc, manifests: ResolvedManifests): ExposedScope {
  const members: Array<[string, string[]]> = []
  const types: Array<[string, Record<string, string>]> = []
  if (page.kind === 'custom') {
    for (const [, node] of byKey(page.nodes)) {
      const manifest = lookup(manifests, node.type)
      if (!manifest?.installed || !manifest.exposes.length) continue
      members.push([node.name, manifest.exposes.map(({ name }) => name)])
      types.push([node.name, Object.fromEntries(manifest.exposes.map(({ name, type }) => [name, type]))])
    }
  }
  return { tier: 'client', members: Object.fromEntries(members), types: Object.fromEntries(types) }
}
