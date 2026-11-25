import { compareBytes } from '../serialize.js'
import type { ResolvedManifest, ResolvedManifests } from './resolve.js'
import { manifestProps, type PropSchema } from './types.js'

export type ManifestIndexEntry = Pick<ResolvedManifest, 'type' | 'slots' | 'events' | 'exposes' | 'installed'>

export interface ManifestJsonSchemas {
  schemas: Record<string, object>
  index: ManifestIndexEntry[]
}

function valueSchema(prop: PropSchema, description: string | undefined): object {
  const shape = prop.kind === 'unknown' ? {} : {
    type: prop.kind === 'enum' || prop.kind === 'className' ? 'string' : prop.kind,
    ...(prop.kind === 'enum' && { enum: prop.options }),
  }
  const label = description ?? prop.description ?? (prop.kind === 'unknown' ? prop.typeText : undefined)
  return {
    ...shape,
    ...(label !== undefined && { description: label }),
    ...(prop.default !== undefined && { default: prop.default }),
  }
}

function propsSchema(manifest: ResolvedManifest): object {
  const props = [...manifestProps(manifest).values()].sort((a, b) => compareBytes(a.name, b.name))
  const descriptions = manifest.propDescriptions ?? {}
  const required = props.filter(({ optional }) => !optional).map(({ name }) => name)
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: manifest.type,
    type: 'object',
    properties: Object.fromEntries(props.map((prop) => [
      prop.name, valueSchema(prop, Object.hasOwn(descriptions, prop.name) ? descriptions[prop.name] : undefined),
    ])),
    ...(required.length > 0 && { required }),
    additionalProperties: false,
  }
}

export function manifestsToJsonSchema(manifests: ResolvedManifests): ManifestJsonSchemas {
  const entries = Object.values(manifests).filter((manifest) => manifest !== undefined)
    .sort((a, b) => compareBytes(a.type, b.type))
  return {
    schemas: Object.fromEntries(entries.map((manifest) => [manifest.type, propsSchema(manifest)])),
    index: entries.map(({ type, slots, events, exposes, installed }) => ({ type, slots, events, exposes, installed })),
  }
}
