// Raw-spec helpers shared by the adapters and the manifest generator: flavor detection,
// canonical hashing and cycle-safe local `$ref` resolution. The spec is treated as untyped
// JSON on purpose — Swagger 2.0, OpenAPI 3.0 and 3.1 differ in shape, and every access is
// checked instead of trusting a nominal type.

import { createHash } from 'node:crypto'

import { ContractSyncError } from '../errors.js'

export type JsonObject = { [key: string]: unknown }

/** A parsed (JSON or YAML) API description, before any validation beyond "is an object". */
export type SpecDocument = JsonObject

export type SpecFlavor = 'swagger-2.0' | 'openapi-3.0' | 'openapi-3.1'

export interface SpecInfo {
  flavor: SpecFlavor
  /** The literal `swagger` / `openapi` field, e.g. "3.1.0". */
  version: string
}

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function detectSpec(spec: unknown): SpecInfo {
  if (!isObject(spec)) {
    throw new ContractSyncError('input_invalid', 'The API description is not a JSON/YAML object')
  }
  const swagger = spec['swagger']
  const openapi = spec['openapi']
  if (typeof swagger === 'string') {
    if (swagger === '2.0') return { flavor: 'swagger-2.0', version: swagger }
    throw new ContractSyncError('unsupported_spec', `Unsupported Swagger version "${swagger}"`, {
      hint: 'Swagger 2.0, OpenAPI 3.0.x and OpenAPI 3.1.x are supported.',
    })
  }
  if (typeof openapi === 'string') {
    if (/^3\.0\.\d+/.test(openapi)) return { flavor: 'openapi-3.0', version: openapi }
    if (/^3\.1\.\d+/.test(openapi)) return { flavor: 'openapi-3.1', version: openapi }
    throw new ContractSyncError('unsupported_spec', `Unsupported OpenAPI version "${openapi}"`, {
      hint: 'Swagger 2.0, OpenAPI 3.0.x and OpenAPI 3.1.x are supported.',
    })
  }
  throw new ContractSyncError(
    'input_invalid',
    'The document has neither a "swagger" nor an "openapi" version field; it is not an API description',
  )
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code units, no whitespace, `undefined` members
 * dropped (as JSON.stringify does). Same output for the same data whatever its source format or
 * key order, which makes it safe to hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ContractSyncError('input_invalid', `Non-finite number ${String(value)} cannot be represented in JSON`)
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
  }
  if (isObject(value)) {
    const members = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${members.join(',')}}`
  }
  throw new ContractSyncError('input_invalid', `Value of type ${typeof value} cannot be represented in JSON`)
}

/** `sha256:<hex>` of the canonical JSON of the spec. */
export function schemaHash(spec: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(spec)).digest('hex')}`
}

function decodePointerToken(token: string): string {
  return decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~')
}

/** The last segment of a local ref, e.g. "#/components/schemas/CustomerDto" → "CustomerDto". */
export function refName(ref: string): string {
  const segments = ref.split('/')
  return decodePointerToken(segments[segments.length - 1] ?? ref)
}

export interface Resolved {
  /** The node after following every `$ref` hop. */
  node: JsonObject
  /** The last `$ref` followed (the most specific named definition), if any. */
  ref: string | undefined
}

/**
 * Resolves local JSON-pointer refs (`#/…`). External refs (other files/URLs) are refused rather
 * than silently treated as unknown: bundle the spec first. Ref chains are followed with a visited
 * set, so `A → B → A` fails with `ref_cycle` instead of looping. Recursive *schemas*
 * (`LineItem.components: LineItem[]`) are fine — callers only resolve one hop at a time.
 */
export class RefResolver {
  readonly #root: SpecDocument

  constructor(root: SpecDocument) {
    this.#root = root
  }

  get(ref: string): unknown {
    if (!ref.startsWith('#')) {
      throw new ContractSyncError('unsupported_ref', `External $ref "${ref}" is not supported`, {
        hint: 'Bundle the spec into one document first (e.g. `redocly bundle`), then re-run.',
      })
    }
    const pointer = ref.slice(1)
    if (pointer === '') return this.#root
    if (!pointer.startsWith('/')) {
      throw new ContractSyncError('unsupported_ref', `Malformed $ref "${ref}" (expected "#/…")`)
    }
    let node: unknown = this.#root
    for (const raw of pointer.slice(1).split('/')) {
      const token = decodePointerToken(raw)
      if (Array.isArray(node)) {
        const index = Number(token)
        node = Number.isInteger(index) ? node[index] : undefined
      } else if (isObject(node)) {
        node = Object.hasOwn(node, token) ? node[token] : undefined
      } else {
        node = undefined
      }
      if (node === undefined) {
        throw new ContractSyncError('input_invalid', `$ref "${ref}" does not resolve to anything in the document`)
      }
    }
    return node
  }

  /** Follows `$ref` hops until a non-ref object. Returns undefined for non-objects. */
  resolve(value: unknown): Resolved | undefined {
    if (!isObject(value)) return undefined
    let node: JsonObject = value
    let ref: string | undefined
    const seen = new Set<string>()
    while (typeof node['$ref'] === 'string') {
      const next = node['$ref']
      if (seen.has(next)) {
        throw new ContractSyncError('ref_cycle', `$ref cycle: ${[...seen, next].join(' → ')}`, {
          hint: 'A $ref must eventually point at a real definition.',
        })
      }
      seen.add(next)
      ref = next
      const target = this.get(next)
      if (!isObject(target)) {
        throw new ContractSyncError('input_invalid', `$ref "${next}" points at a non-object value`)
      }
      node = target
    }
    return { node, ref }
  }
}

/**
 * Copy of `spec` without the given `"METHOD /path"` operations (a path item left with no
 * operation is dropped). Every key must match an operation. This replaces hey-api's
 * `parser.filters.operations.exclude`, which in 0.99.0 also prunes unrelated operations of
 * Swagger 2.0 specs whose operations share `#/parameters/*` refs (PostgREST's do).
 */
export function withoutOperations(spec: SpecDocument, keys: readonly string[]): SpecDocument {
  const copy = structuredClone(spec)
  const paths = copy['paths']
  for (const key of keys) {
    const match = /^([A-Z]+) (\/.*)$/.exec(key)
    const method = match?.[1]?.toLowerCase()
    const route = match?.[2]
    if (method === undefined || route === undefined || !(HTTP_METHODS as readonly string[]).includes(method)) {
      throw new ContractSyncError('usage', `Operation key "${key}" must look like "GET /path"`)
    }
    const pathItem = isObject(paths) ? paths[route] : undefined
    if (!isObject(paths) || !isObject(pathItem) || !isObject(pathItem[method])) {
      throw new ContractSyncError('usage', `Excluded operation "${key}" is not in the spec`)
    }
    delete pathItem[method]
    if (!HTTP_METHODS.some((other) => isObject(pathItem[other]))) delete paths[route]
  }
  return copy
}
