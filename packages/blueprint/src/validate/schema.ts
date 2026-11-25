// Layer 1: the schema (LLD-01 section 5). Each problem becomes a `schema_violation` whose
// pointer names the offending value itself: an unknown property, not its object; the missing
// key of a repeat, not the whole control entry. Never throws.
import type { z } from 'zod'

import { appSchema } from '../types/app.js'
import { toPointer, type Diagnostic } from '../types/diagnostics.js'
import { modelSchema } from '../types/model.js'
import { pageSchema } from '../types/page.js'
import type { BlueprintDoc } from '../serialize.js'

export type SchemaKind = 'app' | 'page' | 'model'
const SCHEMAS: Record<SchemaKind, z.ZodType> = { app: appSchema, page: pageSchema, model: modelSchema }

export interface SchemaResult {
  doc: BlueprintDoc | null
  diagnostics: Diagnostic[]
}

type Path = ReadonlyArray<PropertyKey>
type Issue = z.core.$ZodIssue

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The value at `path`, and whether its last key exists in its parent. */
function lookup(value: unknown, path: Path): { present: boolean } {
  let current = value
  for (const key of path) {
    if (Array.isArray(current) && typeof key === 'number' && key < current.length) current = current[key]
    else if (isObject(current) && Object.hasOwn(current, key as string)) current = current[key as string]
    else return { present: false }
  }
  return { present: true }
}

/**
 * zod drops a `__proto__` key without a word (assigning it sets the prototype), so the next
 * save would lose it. It is refused before parsing.
 */
function protoKeys(value: unknown, path: PropertyKey[] = []): PropertyKey[][] {
  if (Array.isArray(value)) return value.flatMap((v, i) => protoKeys(v, [...path, i]))
  if (!isObject(value)) return []
  return Object.keys(value).flatMap((key) =>
    key === '__proto__' ? [[...path, key]] : protoKeys(value[key], [...path, key]))
}

/** The issues of the union branch that came closest: the one with the fewest issues. */
function closestBranch(branches: readonly (readonly Issue[])[]): readonly Issue[] {
  let best: readonly Issue[] = []
  for (const branch of branches) if (best.length === 0 || branch.length < best.length) best = branch
  return best
}

function flatten(issues: readonly Issue[], prefix: Path, value: unknown): Array<{ path: Path; message: string }> {
  const out: Array<{ path: Path; message: string }> = []
  for (const issue of issues) {
    const path = [...prefix, ...issue.path]
    switch (issue.code) {
      case 'unrecognized_keys':
        for (const key of issue.keys) out.push({ path: [...path, key], message: `Unknown property "${key}"` })
        break
      case 'invalid_union':
        if (issue.errors.length > 0) out.push(...flatten(closestBranch(issue.errors), path, value))
        else {
          const options = 'options' in issue && Array.isArray(issue.options) ? issue.options.map(String).join(', ') : ''
          out.push({ path, message: options ? `Expected one of: ${options}` : issue.message })
        }
        break
      case 'invalid_key':
        out.push({ path, message: `Invalid key "${String(path.at(-1))}": ${issue.issues.map((i) => i.message).join('; ')}` })
        break
      case 'invalid_type':
        out.push({
          path,
          message: path.length > 0 && !lookup(value, path).present
            ? `Missing required property "${String(path.at(-1))}"`
            : issue.message,
        })
        break
      default:
        out.push({ path, message: issue.message })
    }
  }
  return out
}

export function checkSchema(kind: SchemaKind, value: unknown, doc: string): SchemaResult {
  const violation = (path: Path, message: string): Diagnostic =>
    ({ code: 'schema_violation', severity: 'error', doc, pointer: toPointer(path), message })
  const protos = protoKeys(value)
  if (protos.length > 0) {
    return { doc: null, diagnostics: protos.map((path) => violation(path, 'The property name "__proto__" is not allowed')) }
  }
  const parsed = SCHEMAS[kind].safeParse(value)
  if (parsed.success) return { doc: parsed.data as BlueprintDoc, diagnostics: [] }
  return { doc: null, diagnostics: flatten(parsed.error.issues, [], value).map(({ path, message }) => violation(path, message)) }
}
