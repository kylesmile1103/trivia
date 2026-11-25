import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createStandaloneHost, startDevService, type RunningDevService } from '../src/standalone.js'

const FILE = 'src/Page.tsx'
const ORIGINAL = 'export function Page() { return <h1>Before</h1> }\n'
const LOCATOR = `${FILE}#Page#0`
let root: string
let running: RunningDevService

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trivia-standalone-')))
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(path.join(root, FILE), ORIGINAL)
  running = await startDevService(createStandaloneHost(root), { port: 0 })
})

afterEach(async () => {
  await running?.close()
  if (root) await fs.rm(root, { recursive: true, force: true })
})

const api = (endpoint: string, init?: RequestInit) => fetch(`${running.url}/@trivia/api${endpoint}`, init)
function post(endpoint: string, body: unknown) {
  return api(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describe('FR-TN-02: standalone dev service', () => {
  it('binds IPv4 loopback, serves only Trivia paths and shares the engine history', async () => {
    expect(running.server.address()).toMatchObject({ address: '127.0.0.1' })
    expect((await fetch(running.url)).status).toBe(404)
    expect(await (await api('/health')).json()).toMatchObject({ ok: true, data: { root } })
    expect(await (await api(`/inspect?locator=${encodeURIComponent(LOCATOR)}`)).json()).toMatchObject({
      ok: true, data: { locator: LOCATOR, name: 'h1', text: 'Before' },
    })
    const edit = await post('/apply', { op: { op: 'setText', target: LOCATOR, expectedName: 'h1', text: 'After' } })
    expect(await edit.json()).toMatchObject({ ok: true, data: { changed: true, history: { canUndo: true } } })
    expect(await fs.readFile(path.join(root, FILE), 'utf8')).toBe(ORIGINAL.replace('Before', 'After'))
    expect((await post('/undo', {})).status).toBe(200)
    expect(await fs.readFile(path.join(root, FILE), 'utf8')).toBe(ORIGINAL)
  })

  it('serves the existing stateless MCP tools', async () => {
    const client = new Client({ name: 'standalone-test', version: '0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('/@trivia/mcp', running.url)) as unknown as Transport)
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('trivia_get_selection')
      expect((await client.callTool({ name: 'trivia_get_selection' })).isError).not.toBe(true)
    } finally {
      await client.close()
    }
  })

  it('does not resolve source imports outside the project', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'trivia-external-'))
    try {
      await fs.writeFile(path.join(outside, 'Other.tsx'), ORIGINAL)
      await fs.symlink(outside, path.join(root, 'src/external'), 'junction')
      const { resolveModule } = createStandaloneHost(root)
      expect(await resolveModule('./Page', FILE)).toBe(FILE)
      expect(await resolveModule('./external/Other', FILE)).toBeNull()
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.each([
    ['a foreign host', { host: 'other.example' }],
    ['a foreign origin', { origin: 'https://other.example' }],
    ['a non-loopback address', {}],
  ])('refuses %s before either handler runs', async (source, headers) => {
    for (const endpoint of ['/api/health', '/mcp']) {
      if (source === 'a non-loopback address') {
        // The actual bind prevents real remote connections. Exercise the HTTP guard with
        // the peer address a remote connection would carry.
        running.server.prependOnceListener('request', (req) => {
          Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.10' })
        })
      }
      const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const req = http.get(`${running.url}/@trivia${endpoint}`, { headers, agent: false }, (res) => {
          let body = ''
          res.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
          res.on('end', () => resolve({ status: res.statusCode, body }))
        })
        req.on('error', reject)
      })
      expect(response.status).toBe(403)
      const result = JSON.parse(response.body)
      if (endpoint === '/api/health') expect(result.error.code).toBe('forbidden')
      else expect(result).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } })
    }
  })
})

it('FR-RC-09 applies replaceFile as an atomic HTTP batch with byte-exact undo', async () => {
  const file = path.join(root, FILE)
  const before = ORIGINAL.replaceAll('\n', '\r\n')
  await fs.writeFile(file, before)
  const content = before.replace('Before', 'After')
  const expectedHash = `sha256:${createHash('sha256').update(before).digest('hex')}`
  const op = { op: 'replaceFile', file: FILE, expectedHash, content }

  const response = await post('/batch', { ops: [op], label: 'Replace generated page' })
  expect(response.status, await response.clone().text()).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, data: { changed: true } })
  expect(await fs.readFile(file)).toEqual(Buffer.from(content))

  const refuse = async (replacement: typeof op, status: number, code: string) => {
    const response = await post('/apply', { op: replacement })
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ ok: false, error: { code } })
  }
  await refuse(op, 409, 'conflict')
  const unrelated = 'src/Unrelated.tsx'
  const batch = await post('/batch', { ops: [{ op: 'createFile', file: unrelated, content: ORIGINAL }, op] })
  expect(batch.status).toBe(409)
  await expect(fs.stat(path.join(root, unrelated))).rejects.toMatchObject({ code: 'ENOENT' })
  await refuse({ ...op, file: 'src/Missing.tsx' }, 404, 'file_not_found')
  await refuse({
    ...op,
    expectedHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    content: 'export const = <',
  }, 400, 'parse_error')
  expect(await fs.readFile(file)).toEqual(Buffer.from(content))
  expect((await post('/undo', {})).status).toBe(200)
  expect(await fs.readFile(file)).toEqual(Buffer.from(before))
  expect((await post('/redo', {})).status).toBe(200)
  expect(await fs.readFile(file)).toEqual(Buffer.from(content))
})

it('FR-RC-07 creates and restores a TypeScript handler through ordinary history', async () => {
  const file = 'src/handlers/Action.ts'
  const content = 'export function act(_event: unknown): void {}\n'
  const result = await post('/batch', { ops: [{ op: 'createFile', file, content, ifMissing: true }] })
  expect(result.status, await result.clone().text()).toBe(200)
  expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content)
  expect((await post('/undo', {})).status).toBe(200)
  await expect(fs.stat(path.join(root, file))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await post('/redo', {})).status).toBe(200)
  expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content)
})
