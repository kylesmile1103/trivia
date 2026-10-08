// Supabase adapter: fetches PostgREST's Swagger 2.0 document from `<project>/rest/v1/` and marks
// it for PostgREST-style classification (no item paths — rows are selected with filters such as
// `id=eq.1`). Generated code talks to PostgREST through hey-api's fetch client; no
// @supabase/supabase-js is involved.

import { ContractSyncError, describeError } from '../errors.js'
import { POSTGREST_EXCLUDED_OPERATIONS, detectStyle } from '../spec/postgrest.js'
import type { SpecDocument } from '../spec/spec.js'
import { isObject } from '../spec/spec.js'
import type { LoadedSpec } from './rest-adapter.js'
import { parseSpecText, redactUrl } from './rest-adapter.js'

export interface SupabaseSpecOptions {
  /** Project URL, e.g. "https://abcd.supabase.co" (a trailing "/rest/v1" is accepted too). */
  url: string
  /** A secret key (sb_secret_…) or the legacy service_role JWT. */
  key: string
  timeoutMs?: number
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch
}

export interface SupabaseSpec extends LoadedSpec {
  style: 'postgrest'
  /** PostgREST's `GET /` serves this OpenAPI document itself; it is not a data operation. */
  excludeOperations: string[]
}

const OPENAPI_KEYS_HINT =
  'Since 2026-04-08 Supabase serves the OpenAPI document at /rest/v1/ only to a secret key (sb_secret_…) ' +
  'or the legacy service_role key; anon and publishable keys are refused ' +
  '(https://supabase.com/changelog/42949-breaking-change-removing-access-to-openapi-spec-via-the-anon-key).'

/** The PostgREST endpoint for a Supabase project URL. */
export function supabaseRestUrl(projectUrl: string): string {
  let url: URL
  try {
    url = new URL(projectUrl)
  } catch {
    throw new ContractSyncError('usage', `Invalid Supabase URL "${projectUrl}"`, {
      hint: 'Pass the project URL, e.g. https://<project-ref>.supabase.co',
    })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ContractSyncError('usage', `Supabase URL must be http(s), got ${url.protocol}`)
  }
  const base = url.pathname.replace(/\/+$/, '')
  url.pathname = base.endsWith('/rest/v1') ? `${base}/` : `${base}/rest/v1/`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Request headers for the key. New-style keys (sb_publishable_…, sb_secret_…) are not JWTs and
 * belong only on `apikey`; legacy anon/service_role keys are JWTs and also go on Authorization.
 */
export function supabaseHeaders(key: string): Record<string, string> {
  if (key.trim().length === 0) {
    throw new ContractSyncError('usage', 'The Supabase key is empty')
  }
  const headers: Record<string, string> = { accept: 'application/openapi+json, application/json;q=0.9', apikey: key }
  if (!key.startsWith('sb_')) headers['authorization'] = `Bearer ${key}`
  return headers
}

function errorDetails(body: string): { message: string | null; hint: string | null } {
  try {
    const parsed: unknown = JSON.parse(body)
    if (isObject(parsed)) {
      return {
        message: typeof parsed['message'] === 'string' ? parsed['message'] : null,
        hint: typeof parsed['hint'] === 'string' ? parsed['hint'] : null,
      }
    }
  } catch {
    // not JSON; fall through
  }
  return { message: body.trim().slice(0, 300) || null, hint: null }
}

export async function fetchSupabaseSpec(options: SupabaseSpecOptions): Promise<SupabaseSpec> {
  const endpoint = supabaseRestUrl(options.url)
  const shown = redactUrl(endpoint)
  const doFetch = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await doFetch(endpoint, {
      headers: supabaseHeaders(options.key),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    })
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === 'TimeoutError' ? 'timed out' : describeError(cause)
    const detail = cause instanceof Error && cause.cause !== undefined ? ` (${describeError(cause.cause)})` : ''
    throw new ContractSyncError('network_error', `Could not reach Supabase at ${shown}: ${reason}${detail}`, { cause })
  }
  const body = await response.text().catch(() => '')
  if (!response.ok) {
    const { message, hint } = errorDetails(body)
    const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    const hints = [hint ? `Supabase says: ${hint}` : null]
    if (response.status === 401 || response.status === 403) hints.push(OPENAPI_KEYS_HINT)
    if (response.status === 404) hints.push('Check the project URL; the OpenAPI document lives at <project-url>/rest/v1/.')
    const joined = hints.filter((entry): entry is string => entry !== null).join(' ')
    throw new ContractSyncError(
      'http_error',
      `Supabase answered ${status} for GET ${shown}${message ? `: ${message}` : ''}`,
      joined ? { hint: joined } : undefined,
    )
  }
  const spec: SpecDocument = parseSpecText(body, shown, 'json')
  if (spec['swagger'] !== '2.0' || detectStyle(spec) !== 'postgrest') {
    throw new ContractSyncError(
      'input_invalid',
      `${shown} did not return a PostgREST Swagger 2.0 document (no rowFilter.* parameters)`,
      { hint: 'Point --supabase-url at the project URL, not at a specific table or function.' },
    )
  }
  return { spec, source: endpoint, style: 'postgrest', excludeOperations: [...POSTGREST_EXCLUDED_OPERATIONS] }
}
