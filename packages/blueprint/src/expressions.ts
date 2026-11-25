// Every binding expression in a page, found through the schema's expression mark
// (types/common.ts), so a field added to the schema later is found without a list to update.
// This package never parses or evaluates an expression: that is LLD-03's compiler.
import { z } from 'zod'

import { EXPRESSION_META } from './types/common.js'
import { toPointer } from './types/diagnostics.js'
import { contractPageSchema, customPageSchema, type PageDoc } from './types/page.js'

export interface ExpressionSite {
  /** RFC 6901, inside the page document. */
  pointer: string
  expr: string
}

interface Def {
  type: string
  shape?: Record<string, z.ZodType>
  valueType?: z.ZodType
  element?: z.ZodType
  innerType?: z.ZodType
  options?: readonly z.ZodType[]
}
const defOf = (schema: z.ZodType): Def => schema._zod.def as unknown as Def
const isExpression = (schema: z.ZodType): boolean => z.globalRegistry.get(schema)?.[EXPRESSION_META] === true
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type Visit = (expr: string, path: PropertyKey[], replace: (next: string) => void) => void

function walk(schema: z.ZodType, value: unknown, path: PropertyKey[], visit: Visit, replace: (next: unknown) => void): void {
  const def = defOf(schema)
  switch (def.type) {
    case 'string':
      if (typeof value === 'string' && isExpression(schema)) visit(value, path, replace)
      return
    case 'object':
      if (!isObject(value)) return
      for (const [key, field] of Object.entries(def.shape ?? {})) {
        if (value[key] !== undefined) walk(field, value[key], [...path, key], visit, (next) => { value[key] = next })
      }
      return
    case 'record':
      if (!isObject(value) || !def.valueType) return
      for (const key of Object.keys(value)) walk(def.valueType, value[key], [...path, key], visit, (next) => { value[key] = next })
      return
    case 'array':
      if (!Array.isArray(value) || !def.element) return
      value.forEach((item, i) => walk(def.element as z.ZodType, item, [...path, i], visit, (next) => { value[i] = next }))
      return
    case 'optional':
    case 'nullable':
    case 'default':
      if (value !== null && value !== undefined && def.innerType) walk(def.innerType, value, path, visit, replace)
      return
    case 'union': {
      const option = def.options?.find((o) => o.safeParse(value).success)
      if (option) walk(option, value, path, visit, replace)
      return
    }
    default:
  }
}

const schemaOf = (page: PageDoc): z.ZodType => (page.kind === 'custom' ? customPageSchema : contractPageSchema)

/** Every expression of a page, in document order. */
export function expressionsOf(page: PageDoc): ExpressionSite[] {
  const sites: ExpressionSite[] = []
  walk(schemaOf(page), page, [], (expr, path) => sites.push({ pointer: toPointer(path), expr }), () => {})
  return sites
}

/** Replaces every expression of `page` in place with what `fn` returns for it. */
export function rewriteExpressions(page: PageDoc, fn: (expr: string, pointer: string) => string): void {
  walk(schemaOf(page), page, [], (expr, path, replace) => {
    const next = fn(expr, toPointer(path))
    if (next !== expr) replace(next)
  }, () => {})
}

/**
 * Whether `expr` may refer to node `name` (`ui.name`, `ui?.name`, `ui["name"]`). Textual, so
 * it can match inside a string literal: callers use it only to refuse, never to rewrite.
 */
export function mentionsNode(expr: string, name: string): boolean {
  return new RegExp(`\\bui\\s*(?:\\?\\.|\\.)\\s*${name}\\b|\\bui\\s*(?:\\?\\.)?\\[\\s*(['"\`])${name}\\1\\s*\\]`).test(expr)
}
