// Loads an OpenAPI/Swagger document from a file (JSON or YAML) or an http(s) URL — the REST
// adapter for ASP.NET Core, Spring, FastAPI and anything else that publishes a spec.

import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import yaml from 'js-yaml'

import { ContractSyncError, describeError } from '../errors.js'
import type { SpecDocument } from '../spec/spec.js'
import { detectSpec, isObject } from '../spec/spec.js'

export interface LoadedSpec {
  spec: SpecDocument
  /** The input as given (path or URL); the manifest records a normalized form of it. */
  source: string
}

export interface LoadSpecOptions {
  /** Base for relative file paths. Default: process.cwd(). */
  cwd?: string
  /** Extra request headers for URLs. */
  headers?: Readonly<Record<string, string>>
  /** Request timeout for URLs. Default: 30 s. */
  timeoutMs?: number
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch
}

const DEFAULT_ACCEPT = 'application/openapi+json, application/json;q=0.9, application/yaml;q=0.8, */*;q=0.5'

/** YAML 1.2 core schema plus merge keys: no Date/binary coercion, so values stay JSON-compatible. */
function yamlSchema(): yaml.Schema {
  const types = (yaml as unknown as { types?: { merge?: yaml.Type } }).types
  if (!types?.merge) {
    throw new ContractSyncError('environment', 'js-yaml does not expose its merge type; expected js-yaml 4.x')
  }
  return yaml.CORE_SCHEMA.extend({ implicit: [types.merge] })
}

/** URL safe to print: query strings and fragments may carry keys. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`
  } catch {
    return raw
  }
}

function looksLikeJson(text: string): boolean {
  const first = text.trimStart()[0]
  return first === '{' || first === '['
}

/** Parses JSON or YAML text into a spec object and checks it is a supported API description. */
export function parseSpecText(text: string, origin: string, format?: 'json' | 'yaml'): SpecDocument {
  const asJson = format === 'json' || (format === undefined && looksLikeJson(text))
  let parsed: unknown
  try {
    parsed = asJson ? JSON.parse(text) : yaml.load(text, { schema: yamlSchema(), filename: origin })
  } catch (cause) {
    throw new ContractSyncError(
      'input_parse_failed',
      `${origin} is not valid ${asJson ? 'JSON' : 'YAML'}: ${describeError(cause)}`,
      { cause },
    )
  }
  if (!isObject(parsed)) {
    throw new ContractSyncError('input_invalid', `${origin} does not contain a JSON/YAML object`)
  }
  detectSpec(parsed)
  return parsed
}

function formatFromExtension(file: string): 'json' | 'yaml' | undefined {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.json') return 'json'
  if (ext === '.yaml' || ext === '.yml') return 'yaml'
  return undefined
}

function formatFromContentType(contentType: string | null): 'json' | 'yaml' | undefined {
  if (contentType === null) return undefined
  if (/json/i.test(contentType)) return 'json'
  if (/yaml/i.test(contentType)) return 'yaml'
  return undefined
}

export async function loadSpecFromUrl(url: string, options: LoadSpecOptions = {}): Promise<LoadedSpec> {
  const shown = redactUrl(url)
  const doFetch = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await doFetch(url, {
      headers: { accept: DEFAULT_ACCEPT, ...options.headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    })
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === 'TimeoutError' ? 'timed out' : describeError(cause)
    const detail = cause instanceof Error && cause.cause !== undefined ? ` (${describeError(cause.cause)})` : ''
    throw new ContractSyncError('network_error', `Could not fetch ${shown}: ${reason}${detail}`, {
      cause,
      hint: 'Check that the server is running and the URL is reachable from this machine.',
    })
  }
  const body = await response.text().catch(() => '')
  if (!response.ok) {
    const snippet = body.trim().slice(0, 300)
    throw new ContractSyncError(
      'http_error',
      `GET ${shown} answered HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${snippet ? `: ${snippet}` : ''}`,
      { hint: 'Make sure the URL serves the OpenAPI/Swagger document itself (often /openapi.json or /swagger/v1/swagger.json).' },
    )
  }
  const spec = parseSpecText(body, shown, formatFromContentType(response.headers.get('content-type')))
  return { spec, source: url }
}

export async function loadSpecFromFile(file: string, options: LoadSpecOptions = {}): Promise<LoadedSpec> {
  const absolute = path.resolve(options.cwd ?? process.cwd(), file)
  let text: string
  try {
    text = await fsp.readFile(absolute, 'utf8')
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new ContractSyncError('input_not_found', `Spec file not found: ${absolute}`, { cause })
    }
    throw new ContractSyncError('input_unreadable', `Cannot read spec file ${absolute}: ${describeError(cause)}`, { cause })
  }
  return { spec: parseSpecText(text, absolute, formatFromExtension(absolute)), source: file }
}

/** Loads a spec from a path, `file:` URL or http(s) URL. */
export async function loadSpec(input: string, options: LoadSpecOptions = {}): Promise<LoadedSpec> {
  if (/^https?:\/\//i.test(input)) return loadSpecFromUrl(input, options)
  if (/^file:\/\//i.test(input)) return loadSpecFromFile(fileURLToPath(input), options)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    throw new ContractSyncError('usage', `Unsupported input URL scheme in ${redactUrl(input)}`, {
      hint: 'Use a file path or an http(s) URL.',
    })
  }
  return loadSpecFromFile(input, options)
}
