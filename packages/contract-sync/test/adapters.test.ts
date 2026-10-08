import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadSpec, parseSpecText, redactUrl } from '../src/adapters/rest-adapter.js'
import { fetchSupabaseSpec, supabaseHeaders, supabaseRestUrl } from '../src/adapters/supabase-adapter.js'
import { ContractSyncError } from '../src/errors.js'
import { syncContract } from '../src/sync.js'
import { fixture, makeProject, removeProject } from './helpers.js'

async function failure(promise: Promise<unknown>): Promise<ContractSyncError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof ContractSyncError)) throw new Error(`expected a ContractSyncError, got ${String(error)}`)
  return error
}

describe('rest adapter: files', () => {
  let dir: string
  beforeAll(async () => {
    dir = await makeProject('trivia-adapter-')
  })
  afterAll(async () => {
    await removeProject(dir)
  })

  it('loads JSON and YAML specs relative to cwd', async () => {
    const json = await loadSpec(fixture('customers.openapi.json'))
    expect(json.spec['openapi']).toBe('3.1.0')
    await fsp.copyFile(fixture('orders.openapi.yaml'), path.join(dir, 'orders.yaml'))
    const yaml = await loadSpec('orders.yaml', { cwd: dir })
    expect(yaml.spec['openapi']).toBe('3.0.3')
    expect(yaml.source).toBe('orders.yaml')
  })

  it('keeps YAML scalars JSON-compatible (no Date coercion) and supports merge keys', () => {
    const spec = parseSpecText(
      [
        'openapi: 3.1.0',
        'info: { title: T, version: 2024-01-01 }',
        'paths: {}',
        'x-base: &base { a: 1 }',
        'x-merged: { <<: *base, b: 2 }',
      ].join('\n'),
      'inline.yaml',
      'yaml',
    )
    expect((spec['info'] as Record<string, unknown>)['version']).toBe('2024-01-01')
    expect(spec['x-merged']).toEqual({ a: 1, b: 2 })
  })

  it('reports a missing file, bad JSON, bad YAML and non-API documents precisely', async () => {
    expect(await failure(loadSpec('nope.json', { cwd: dir }))).toMatchObject({ code: 'input_not_found' })

    await fsp.writeFile(path.join(dir, 'bad.json'), '{ "openapi": "3.1.0", ')
    const badJson = await failure(loadSpec('bad.json', { cwd: dir }))
    expect(badJson.code).toBe('input_parse_failed')
    expect(badJson.message).toContain('is not valid JSON')

    await fsp.writeFile(path.join(dir, 'bad.yaml'), 'openapi: 3.1.0\ninfo: [unclosed\n')
    const badYaml = await failure(loadSpec('bad.yaml', { cwd: dir }))
    expect(badYaml.code).toBe('input_parse_failed')
    expect(badYaml.message).toContain('is not valid YAML')

    await fsp.writeFile(path.join(dir, 'package.json'), '{ "name": "not-a-spec" }')
    expect(await failure(loadSpec('package.json', { cwd: dir }))).toMatchObject({ code: 'input_invalid' })

    await fsp.writeFile(path.join(dir, 'old.json'), '{ "swagger": "1.2", "paths": {} }')
    expect(await failure(loadSpec('old.json', { cwd: dir }))).toMatchObject({ code: 'unsupported_spec' })
  })

  it('rejects unsupported URL schemes', async () => {
    expect(await failure(loadSpec('ftp://example.test/spec.json'))).toMatchObject({ code: 'usage' })
  })
})

describe('rest adapter: URLs (loopback server, no external network)', () => {
  let server: http.Server
  let base: string
  const seenHeaders: http.IncomingHttpHeaders[] = []
  let customers: string
  let orders: string

  beforeAll(async () => {
    customers = await fsp.readFile(fixture('customers.openapi.json'), 'utf8')
    orders = await fsp.readFile(fixture('orders.openapi.yaml'), 'utf8')
    server = http.createServer((request, response) => {
      seenHeaders.push(request.headers)
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname === '/openapi.json') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(customers)
      } else if (url.pathname === '/openapi.yaml') {
        response.writeHead(200, { 'content-type': 'application/yaml' }).end(orders)
      } else if (url.pathname === '/boom') {
        response.writeHead(500, { 'content-type': 'text/plain' }).end('database exploded')
      } else {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('no spec here')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('fetches JSON and YAML, sending extra headers', async () => {
    const json = await loadSpec(`${base}/openapi.json`, { headers: { 'x-api-key': 'k1' } })
    expect(json.spec['openapi']).toBe('3.1.0')
    expect(seenHeaders.at(-1)?.['x-api-key']).toBe('k1')
    expect(seenHeaders.at(-1)?.['accept']).toContain('application/json')
    const yaml = await loadSpec(`${base}/openapi.yaml`)
    expect(yaml.spec['openapi']).toBe('3.0.3')
  })

  it('surfaces HTTP status and body, without leaking query strings', async () => {
    const notFound = await failure(loadSpec(`${base}/missing?apikey=super-secret`))
    expect(notFound.code).toBe('http_error')
    expect(notFound.message).toContain('HTTP 404')
    expect(notFound.message).toContain('no spec here')
    expect(notFound.message).not.toContain('super-secret')
    expect(notFound.message).toContain('/missing?…')
    const serverError = await failure(loadSpec(`${base}/boom`))
    expect(serverError.message).toContain('HTTP 500')
    expect(serverError.message).toContain('database exploded')
  })

  it('reports connection failures as network errors', async () => {
    const closed = http.createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const error = await failure(loadSpec(`http://127.0.0.1:${port}/openapi.json`))
    expect(error.code).toBe('network_error')
    expect(error.message).toContain(`127.0.0.1:${port}`)
  })

  it('redacts query strings', () => {
    expect(redactUrl('https://api.test/spec.json?token=abc#x')).toBe('https://api.test/spec.json?…')
    expect(redactUrl('https://api.test/spec.json')).toBe('https://api.test/spec.json')
  })
})

describe('supabase adapter', () => {
  const SECRET = 'sb_secret_0123456789abcdefghij'
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl'
  let postgrest: string

  beforeAll(async () => {
    postgrest = await fsp.readFile(fixture('postgrest.swagger.json'), 'utf8')
  })

  function fakeFetch(respond: () => Response): { fetch: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } })
      return respond()
    }) as typeof fetch
    return { fetch: fetchImpl, calls }
  }

  it('builds the PostgREST endpoint from the project URL', () => {
    expect(supabaseRestUrl('https://abc.supabase.co')).toBe('https://abc.supabase.co/rest/v1/')
    expect(supabaseRestUrl('https://abc.supabase.co/')).toBe('https://abc.supabase.co/rest/v1/')
    expect(supabaseRestUrl('https://abc.supabase.co/rest/v1')).toBe('https://abc.supabase.co/rest/v1/')
    expect(supabaseRestUrl('http://localhost:54321?x=1')).toBe('http://localhost:54321/rest/v1/')
    expect(() => supabaseRestUrl('not a url')).toThrow(ContractSyncError)
  })

  it('sends new-style keys only on apikey, legacy JWT keys on apikey and Authorization', () => {
    expect(supabaseHeaders(SECRET)).toEqual({ accept: 'application/openapi+json, application/json;q=0.9', apikey: SECRET })
    expect(supabaseHeaders(JWT)).toEqual({
      accept: 'application/openapi+json, application/json;q=0.9',
      apikey: JWT,
      authorization: `Bearer ${JWT}`,
    })
    expect(() => supabaseHeaders('  ')).toThrow(/empty/)
  })

  it('fetches the Swagger 2.0 document and marks it PostgREST, excluding the introspection root', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(postgrest, { status: 200, headers: { 'content-type': 'application/openapi+json' } }))
    const result = await fetchSupabaseSpec({ url: 'https://abc.supabase.co', key: SECRET, fetch })
    expect(calls).toEqual([
      {
        url: 'https://abc.supabase.co/rest/v1/',
        headers: { accept: 'application/openapi+json, application/json;q=0.9', apikey: SECRET },
      },
    ])
    expect(result.style).toBe('postgrest')
    expect(result.excludeOperations).toEqual(['GET /'])
    expect(result.spec['swagger']).toBe('2.0')
  })

  it('surfaces the exact status and Supabase’s own message and hint when the key is refused', async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            message: 'Access to schema is forbidden',
            hint: 'Accessing the schema via the Data API is only allowed using a secret API key.',
          }),
          { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } },
        ),
    )
    const error = await failure(fetchSupabaseSpec({ url: 'https://abc.supabase.co', key: JWT, fetch }))
    expect(error.code).toBe('http_error')
    expect(error.message).toBe(
      'Supabase answered HTTP 401 Unauthorized for GET https://abc.supabase.co/rest/v1/: Access to schema is forbidden',
    )
    expect(error.hint).toContain('Supabase says: Accessing the schema via the Data API is only allowed using a secret API key.')
    expect(error.hint).toContain('secret key (sb_secret_…) or the legacy service_role key')
    expect(`${error.message} ${error.hint}`).not.toContain(JWT)
  })

  it('does not guess for other statuses: the status and body are reported as-is', async () => {
    const { fetch } = fakeFetch(() => new Response('upstream timeout', { status: 504 }))
    const error = await failure(fetchSupabaseSpec({ url: 'https://abc.supabase.co', key: SECRET, fetch }))
    expect(error.message).toBe('Supabase answered HTTP 504 for GET https://abc.supabase.co/rest/v1/: upstream timeout')
    expect(error.hint).toBeUndefined()
  })

  it('rejects a document that is not PostgREST’s', async () => {
    const customers = await fsp.readFile(fixture('customers.openapi.json'), 'utf8')
    const { fetch } = fakeFetch(() => new Response(customers, { status: 200 }))
    expect(await failure(fetchSupabaseSpec({ url: 'https://abc.supabase.co', key: SECRET, fetch }))).toMatchObject({
      code: 'input_invalid',
    })
  })

  it('reports network failures', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND abc.supabase.co') })
    }) as typeof fetch
    const error = await failure(fetchSupabaseSpec({ url: 'https://abc.supabase.co', key: SECRET, fetch: fetchImpl }))
    expect(error.code).toBe('network_error')
    expect(error.message).toContain('ENOTFOUND')
  })

  it('runs the whole pipeline from Supabase into a project', async () => {
    const root = await makeProject()
    try {
      const { fetch } = fakeFetch(() => new Response(postgrest, { status: 200 }))
      const { manifest } = await syncContract({ supabase: { url: 'https://abc.supabase.co', key: SECRET }, cwd: root, fetch })
      expect(manifest.source.location).toBe('https://abc.supabase.co/rest/v1/')
      expect(manifest.source.style).toBe('postgrest')
      expect(manifest.resources.map((resource) => resource.name)).toEqual(['Customer', 'Org', 'Rpc'])
      expect(JSON.stringify(manifest)).not.toContain(SECRET)
    } finally {
      await removeProject(root)
    }
  })
})
