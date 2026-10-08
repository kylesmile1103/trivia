// PostgREST knowledge shared by the adapter, codegen and the manifest generator. Facts follow
// PostgREST's OpenAPI generator (src/PostgREST/Response/OpenAPI.hs, v12.2.3).

import type { ApiStyle } from './manifest-types.js'
import type { SpecDocument } from './spec.js'
import { isObject } from './spec.js'

/** PostgREST specs are Swagger 2.0 with `rowFilter.<table>.<column>` parameter definitions. */
export function detectStyle(spec: SpecDocument): ApiStyle {
  const parameters = spec['parameters']
  return spec['swagger'] === '2.0' && isObject(parameters) && Object.keys(parameters).some((key) => key.startsWith('rowFilter.'))
    ? 'postgrest'
    : 'rest'
}

/** `GET /` is PostgREST's introspection endpoint (tag "Introspection"): it serves the spec itself. */
export const POSTGREST_EXCLUDED_OPERATIONS: readonly string[] = ['GET /']

export function defaultExcludedOperations(style: ApiStyle): readonly string[] {
  return style === 'postgrest' ? POSTGREST_EXCLUDED_OPERATIONS : []
}

/**
 * Prepares a COPY of a PostgREST spec for hey-api. PostgREST declares table reads as
 * `200: { schema: array of rows }` plus `206 Partial Content` without a schema, although a 206 is
 * the same row array (a ranged page). hey-api types a schema-less response as `unknown`, and
 * `Array<Row> | unknown` collapses to `unknown`, which would make every read untyped. Giving
 * 206 the 200 schema states what PostgREST actually returns. Mutates and returns `copy`.
 */
export function patchPostgrestForCodegen(copy: SpecDocument): SpecDocument {
  const paths = copy['paths']
  if (!isObject(paths)) return copy
  for (const pathItem of Object.values(paths)) {
    if (!isObject(pathItem)) continue
    const responses = isObject(pathItem['get']) ? pathItem['get']['responses'] : undefined
    if (!isObject(responses)) continue
    const ok = responses['200']
    const partial = responses['206']
    if (isObject(ok) && ok['schema'] !== undefined && isObject(partial) && partial['schema'] === undefined) {
      responses['206'] = { ...partial, schema: structuredClone(ok['schema']) }
    }
  }
  return copy
}
