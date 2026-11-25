import { compareBytes } from '../serialize.js'
import type { Blueprint } from '../store.js'
import { toPointer, type Diagnostic } from '../types/diagnostics.js'
import type { CustomPage } from '../types/page.js'
import type { LayerCheck } from '../validate/context.js'
import type { ResolvedManifests } from './resolve.js'
import type { ComponentManifest, PropSchema } from './types.js'

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
        const slot = parentManifest.slots.find(({ name }) => name === node.slot)
        const path = ['nodes', id, 'slot']
        if (!slot) {
          report('unknown_slot', path, `${parent.type} has no slot "${node.slot}". Available slots: ${describe(parentManifest.slots.map(({ name }) => name))}`)
        } else if (slot.kind === 'text') {
          report('invalid_slot_content', path, `${parent.type}.${slot.name} accepts text`)
        } else if (slot.accepts && !slot.accepts.includes(node.type)) {
          report('invalid_slot_content', path, `${parent.type}.${slot.name} accepts: ${describe(slot.accepts)}`)
        }
      }
    }

    const textChildren = manifest.slots.some(({ kind }) => kind === 'text')
    for (const map of ['props', 'bindings'] as const) {
      for (const [name, value] of byKey(page[map][id] ?? {})) {
        const path = [map, id, name]
        const prop = manifest.props.find((prop) => prop.name === name)
        if (!prop && !(name === 'children' && textChildren)) {
          report('unknown_prop', path, `${node.type} has no prop "${name}"`,
            `Check the component source and its blueprint/manifests/${node.type}.manifest.json override.`)
        } else if (map === 'props') {
          const expected = prop ? invalidValue(prop, value) : typeof value === 'string' ? undefined : 'string'
          if (expected) report('invalid_prop_value', path, `${node.type}.${name} expects ${expected}`)
        }
      }
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
