import { z } from 'zod'

import { EVENT, HANDLER, NODE_TYPE, PROP, SLOT, json, name } from '../types/common.js'

const typeName = z.string().regex(NODE_TYPE)
const slotName = z.string().regex(SLOT)
const propName = z.string().regex(PROP)
const exportName = z.string().regex(HANDLER)
const eventName = z.string().regex(EVENT)
const text = z.string().min(1)

const propFields = {
  name: propName,
  optional: z.boolean(),
  default: json.optional(),
  source: z.enum(['declared', 'variant', 'intrinsic']),
  description: text.optional(),
}

/** The prop analyzer's serialized shape, with an optional manifest description. */
export const propSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...propFields, kind: z.literal('enum'), options: z.array(z.string()).min(1) }),
  z.strictObject({ ...propFields, kind: z.literal('boolean') }),
  z.strictObject({ ...propFields, kind: z.literal('string') }),
  z.strictObject({ ...propFields, kind: z.literal('number') }),
  z.strictObject({ ...propFields, kind: z.literal('className') }),
  z.strictObject({ ...propFields, kind: z.literal('unknown'), typeText: text }),
])

export type PropSchema = z.output<typeof propSchema>

/** The engine's component analyzer result, mirrored so resolution has no engine dependency. */
export interface ComponentSchema {
  name: string
  file: string
  importSource: string
  baseElement: string | null
  acceptsChildren: boolean
  props: PropSchema[]
  unresolvedTypes?: string[]
}

const slotSchema = z.strictObject({
  name: slotName,
  kind: z.enum(['nodes', 'text']),
  accepts: z.array(typeName).optional(),
  wrapper: exportName.optional(),
})
const eventSchema = z.strictObject({ name: eventName, prop: eventName, payload: text.optional() })
const exposedValueSchema = z.strictObject({
  name,
  type: text,
  initial: json,
  via: z.strictObject({
    valueProp: propName,
    changeProp: eventName,
    changeArg: z.enum(['value', 'event.target.value', 'event.target.checked', 'value === true']),
  }),
})

const manifestFields = z.strictObject({
  source: z.strictObject({
    registry: z.enum(['shadcn', 'refine', 'local']),
    item: text,
    import: z.strictObject({ name: exportName, from: text }),
    parts: z.record(slotName, exportName).optional(),
  }),
  props: z.array(propSchema),
  configuration: z.array(propSchema).optional(),
  slots: z.array(slotSchema),
  events: z.array(eventSchema),
  exposes: z.array(exposedValueSchema),
  client: z.boolean(),
  template: z.strictObject({ props: z.record(propName, json).optional(), children: z.string().optional() }),
  composite: z.enum(['DataTable', 'Form']).optional(),
})

export const componentManifestSchema = manifestFields.extend({
  type: typeName,
  variants: z.record(z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), manifestFields.partial()).optional(),
})

export type ComponentManifest = z.output<typeof componentManifestSchema>
export type ManifestSlot = z.output<typeof slotSchema>
export type ManifestEvent = z.output<typeof eventSchema>
export type ExposedValue = z.output<typeof exposedValueSchema>

export function manifestJsonSchema(): object {
  return z.toJSONSchema(componentManifestSchema, { target: 'draft-2020-12', io: 'input' })
}

/** Static prop contracts include structural text and controlled values described by the manifest. */
export function manifestProps(manifest: Pick<ComponentManifest, 'props' | 'slots' | 'exposes' | 'configuration'>): Map<string, PropSchema> {
  const props = new Map([...manifest.props, ...(manifest.configuration ?? [])].map((prop) => [prop.name, prop]))
  if (!props.has('children') && manifest.slots.some(({ kind }) => kind === 'text')) {
    props.set('children', { name: 'children', kind: 'string', optional: true, source: 'declared' })
  }
  for (const { type, via: { valueProp } } of manifest.exposes) {
    if (props.has(valueProp)) continue
    const base = { name: valueProp, optional: true, source: 'declared' as const }
    if (type === 'string' || type === 'number' || type === 'boolean') props.set(valueProp, { ...base, kind: type })
    else props.set(valueProp, { ...base, kind: 'unknown', typeText: type })
  }
  return props
}
