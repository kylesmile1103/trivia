// Canonical serialization (LLD-01 section 3, FR-BP-04): UTF-8 JSON, two-space indentation, LF,
// one final newline. Fixed properties in schema order, map entries and free JSON objects
// sorted bytewise by key, arrays in order, properties equal to their default omitted.
//
// The order and the defaults come from walking the zod schemas, so the types stay the one
// source of truth. Printing goes through ordered entries rather than JSON.stringify of an
// object: a JavaScript object puts integer-like keys ("2", "10") first, whatever the order
// they were inserted in.
import { createHash } from 'node:crypto'

import type { z } from 'zod'

import { appSchema, type AppDoc } from './types/app.js'
import { SCHEMA_URL } from './types/common.js'
import { modelSchema, type ModelDoc } from './types/model.js'
import { pageSchema, type PageDoc } from './types/page.js'

export type BlueprintDoc = AppDoc | PageDoc | ModelDoc

/** An object whose entries are already in the order they print in. */
class Ordered {
  constructor(readonly entries: ReadonlyArray<readonly [string, Canon]>) {}
}
type Canon = null | boolean | number | string | Canon[] | Ordered

/** The zod internals the walk reads. Only these fields of `_zod.def` are used. */
interface Def {
  type: string
  shape?: Record<string, z.ZodType>
  catchall?: z.ZodType
  valueType?: z.ZodType
  element?: z.ZodType
  innerType?: z.ZodType
  defaultValue?: unknown
  options?: readonly z.ZodType[]
  getter?: () => z.ZodType
}
const defOf = (schema: z.ZodType): Def => schema._zod.def as unknown as Def

/** Bytewise on UTF-8, which differs from JavaScript's UTF-16 order above U+FFFF. */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** Equality of two JSON values, ignoring key order. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]))
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** JSON whose shape no schema describes: printed in the order it was read. */
function asWritten(value: unknown): Canon {
  if (Array.isArray(value)) return value.map(asWritten)
  if (isObject(value)) return new Ordered(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, asWritten(v)]))
  return value as Canon
}

function sortedEntries(value: Record<string, unknown>, each: (v: unknown) => Canon): Ordered {
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort(compareBytes)
  return new Ordered(keys.map((k) => [k, each(value[k])]))
}

function canon(schema: z.ZodType, value: unknown): Canon {
  const def = defOf(schema)
  switch (def.type) {
    case 'object': {
      if (!isObject(value)) return asWritten(value)
      const shape = def.shape ?? {}
      const entries: Array<readonly [string, Canon]> = []
      for (const [key, field] of Object.entries(shape)) {
        const v = value[key]
        if (v === undefined) continue
        const fieldDef = defOf(field)
        if (fieldDef.type === 'default' && jsonEqual(v, fieldDef.defaultValue)) continue
        entries.push([key, canon(field, v)])
      }
      // Only a loose object (the model document) has properties its shape does not name.
      for (const [key, v] of Object.entries(value)) {
        if (!Object.hasOwn(shape, key) && v !== undefined) entries.push([key, asWritten(v)])
      }
      return new Ordered(entries)
    }
    case 'record':
      return isObject(value) && def.valueType ? sortedEntries(value, (v) => canon(def.valueType as z.ZodType, v)) : asWritten(value)
    case 'array':
      return Array.isArray(value) && def.element ? value.map((v) => canon(def.element as z.ZodType, v)) : asWritten(value)
    case 'default':
    case 'optional':
    case 'nullable':
    case 'readonly':
      return value === null || value === undefined || !def.innerType ? (value ?? null) as Canon : canon(def.innerType, value)
    case 'lazy':
      return def.getter ? canon(def.getter(), value) : asWritten(value)
    case 'union': {
      // The first option the value satisfies decides its shape: for free JSON (z.json()) that
      // is the record option, so its keys sort.
      const option = def.options?.find((o) => o.safeParse(value).success)
      return option ? canon(option, value) : asWritten(value)
    }
    default:
      return asWritten(value)
  }
}

function print(value: Canon, indent: string): string {
  if (value instanceof Ordered) {
    if (value.entries.length === 0) return '{}'
    const inner = indent + '  '
    return `{\n${value.entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${print(v, inner)}`).join(',\n')}\n${indent}}`
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const inner = indent + '  '
    return `[\n${value.map((v) => inner + print(v, inner)).join(',\n')}\n${indent}]`
  }
  return JSON.stringify(value)
}

/** The schema a document's `$schema` names. */
export function schemaFor(doc: { $schema?: unknown }): z.ZodType {
  switch (doc.$schema) {
    case SCHEMA_URL.app:
      return appSchema
    case SCHEMA_URL.page:
      return pageSchema
    case SCHEMA_URL.model:
      return modelSchema
    default:
      throw new TypeError(`serialize: unknown $schema ${JSON.stringify(doc.$schema)}`)
  }
}

/** The canonical bytes of a valid document. */
export function serialize(doc: BlueprintDoc): string {
  return print(canon(schemaFor(doc), doc), '') + '\n'
}

/** `sha256:` and the hex digest of some bytes: the revision of a file as it is on disk. */
export function revOfText(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A document's revision: the hash of its canonical bytes. Computed, never stored. */
export function rev(doc: BlueprintDoc): string {
  return revOfText(serialize(doc))
}
