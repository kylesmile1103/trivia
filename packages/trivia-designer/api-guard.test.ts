// The designer's proxy must not hand the engine API (/@trivia/api) to other machines. The
// user's dev server cannot refuse them itself: the proxy reaches it from loopback with Host
// rewritten (docs/api.md, Envelope). These tests start the designer's real vite.config.ts with
// `--host` in front of a stub "user server" that records every request reaching it.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiGuard, guardMiddleware, isApiPath, isApiUpgrade } from './api-guard.ts'

/** This machine's first non-loopback IPv4 address: a client bound to it is "on the LAN". */
const LAN = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a !== undefined && a.family === 'IPv4' && !a.internal)?.address

/** What the plugin treats as the API (vite-plugin-ast-locator/src/api.ts). */
const reachesApi = (url: string) => new URL(url, 'http://localhost').pathname.startsWith('/@trivia/api/')

let upstream: http.Server
let designer: ViteDevServer
let port: number
/** `METHOD url` of every request the stub user server received. */
let received: string[] = []

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`)
    req.resume()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, data: 'from the user server' }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  // Read by vite.config.ts when createServer loads it.
  vi.stubEnv('TRIVIA_TARGET', `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`)
  designer = await createServer({
    configFile: path.join(import.meta.dirname, 'vite.config.ts'),
    logLevel: 'silent',
    // `--host`, on a port of the OS's choosing.
    server: { host: true, port: 0, strictPort: true, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  await designer.listen()
  const address = designer.httpServer?.address()
  if (address === null || address === undefined || typeof address === 'string') throw new Error('the designer is not on TCP')
  port = address.port
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await designer?.close()
  await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()))
})

beforeEach(() => {
  received = []
})

interface Reply {
  status: number
  body: any
}

interface Send {
  /** Client address: `127.0.0.1` (this machine) or LAN. */
  from: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

/** One request to the designer; `from` is both the address dialled and the client's own. */
function send(url: string, { from, method = 'GET', headers = {}, body }: Send): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: from, localAddress: from, port, path: url, method, headers, agent: false })
    const finish = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: unknown = text
        try {
          parsed = JSON.parse(text)
        } catch {
          // not JSON: keep the text
        }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    }
    req.on('response', finish)
    // A WebSocket upgrade that succeeded: the API has none, so this is a failure too.
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode ?? 101, body: 'upgraded' })
    })
    req.on('error', reject)
    req.end(body)
  })
}

const post = (url: string, from: string, headers: Record<string, string> = {}) =>
  send(url, {
    from,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ op: { op: 'insert', target: 'src/App.tsx#App#0', placement: 'lastChild', snippet: '<p>pwned</p>' } }),
  })

const WEBSOCKET = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }

describe('the designer started with --host', () => {
  it('still forwards the engine API for this machine', async () => {
    const r = await send('/@trivia/api/health', { from: '127.0.0.1', headers: { origin: `http://localhost:${port}` } })
    expect([r.status, r.body.data]).toEqual([200, 'from the user server'])
    expect(received).toEqual(['GET /@trivia/api/health'])
  })

  it.skipIf(LAN === undefined)('refuses the engine API to another machine before its proxy forwards it', async () => {
    const lan = LAN as string
    for (const r of [await send('/@trivia/api/components', { from: lan }), await post('/@trivia/api/apply', lan)]) {
      expect([r.status, r.body.ok, r.body.error?.code]).toEqual([403, false, 'forbidden'])
      // The server listens on `::`, so it sees the IPv4-mapped address.
      expect(r.body.error.message).toContain(`refusing a request from ::ffff:${lan}`)
    }
    expect(received).toEqual([])
  })

  it.skipIf(LAN === undefined)('still proxies the rest of the user app to another machine', async () => {
    const r = await send('/src/main.tsx', { from: LAN as string })
    expect(r.status).toBe(200)
    expect(received).toEqual(['GET /src/main.tsx'])
  })

  it.skipIf(LAN === undefined)('no spelling of an API path gets one through to the user server', async () => {
    const lan = LAN as string
    const spellings = [
      '/@trivia/api/apply?label=x',
      '/./@trivia/api/apply',
      '/x/../@trivia/api/apply',
      '/x/%2e%2e/@trivia/api/apply',
      '/x/%2E./@trivia/api/apply',
      '//evil.example/@trivia/api/apply',
      '/\\evil.example/@trivia/api/apply',
      '///@trivia/api/apply',
      '/@trivia/api//apply',
      '/@trivia/api/',
      // Normalizes to `//evil.example/@trivia/api/apply`, which the plugin then reads as a
      // host and the API path.
      '/x/..//evil.example/@trivia/api/apply',
      '/x/%2e%2e//evil.example/@trivia/api/apply',
      '//x/..//evil.example/@trivia/api/apply',
      '/x/../\\evil.example/@trivia/api/apply',
      '/%2E//evil.example/@trivia/api/apply',
    ]
    for (const url of spellings) await post(url, lan)
    expect(received.filter((line) => reachesApi(line.split(' ')[1] ?? '/'))).toEqual([])
  })

  it('refuses a foreign Origin itself, as the plugin does', async () => {
    for (const origin of ['http://evil.example', 'null', `http://192.168.1.66:${port}`]) {
      const r = await send('/@trivia/api/health', { from: '127.0.0.1', headers: { origin } })
      expect([r.status, r.body.error?.code], origin).toEqual([403, 'forbidden'])
    }
    expect(received).toEqual([])
  })

  it('never tunnels a WebSocket upgrade to the engine API, which has none', async () => {
    for (const from of ['127.0.0.1', ...(LAN === undefined ? [] : [LAN])]) {
      const r = await send('/@trivia/api/components', { from, headers: WEBSOCKET })
      expect(r.status, from).toBe(404)
    }
    expect(received).toEqual([])
  })
})

// The rules themselves, without servers: Vite checks Host before the guard runs (except under
// server.https), so the end-to-end tests above cannot reach that rule.
describe('guardMiddleware', () => {
  interface Outcome {
    status: number | 'next'
    code?: string
    message?: string
  }

  interface Call {
    address?: string | undefined
    headers?: Record<string, string>
    allowedHosts?: readonly string[] | true
  }

  function run(url: string, { address = '127.0.0.1', headers = { host: 'localhost:4400' }, allowedHosts = [] }: Call = {}): Outcome {
    const req = { url, headers, socket: { remoteAddress: address } } as unknown as http.IncomingMessage
    let outcome: Outcome = { status: 'next' }
    const res = {
      statusCode: 200,
      setHeader() {},
      end(this: { statusCode: number }, body: string) {
        const { error } = JSON.parse(body) as { error: { code: string; message: string } }
        outcome = { status: this.statusCode, code: error.code, message: error.message }
      },
    } as unknown as http.ServerResponse
    guardMiddleware(allowedHosts)(req, res, () => {})
    return outcome
  }

  it('answers loopback clients: 127.0.0.0/8, ::1, IPv4-mapped 127.x', () => {
    for (const address of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
      expect(run('/@trivia/api/health', { address }).status, address).toBe('next')
    }
  })

  it('refuses every other address, and an unknown one, with the plugin envelope', () => {
    for (const address of ['192.168.1.66', '::ffff:192.168.1.66', '10.0.0.2', '0.0.0.0', 'fe80::1', '::', '2001:db8::1']) {
      const r = run('/@trivia/api/apply', { address })
      expect([r.status, r.code], address).toEqual([403, 'forbidden'])
      expect(r.message).toContain(`refusing a request from ${address}`)
    }
    // A closed connection has no address.
    const unknown = { status: 0, message: '' }
    const req = { url: '/@trivia/api/health', headers: { host: 'localhost' }, socket: {} } as unknown as http.IncomingMessage
    const res = {
      setHeader() {},
      end(body: string) {
        unknown.message = (JSON.parse(body) as { error: { message: string } }).error.message
      },
      set statusCode(code: number) {
        unknown.status = code
      },
    } as unknown as http.ServerResponse
    guardMiddleware([])(req, res, () => {})
    expect(unknown.status).toBe(403)
    expect(unknown.message).toContain('unknown address')
  })

  it('leaves every other path alone, whoever asks', () => {
    for (const url of ['/', '/src/main.tsx', '/@vite/client', '/__trivia/', '/@trivia/apiary', '/%40trivia/api/apply']) {
      expect(run(url, { address: '192.168.1.66' }).status, url).toBe('next')
    }
  })

  it("follows the plugin's Host rule, which Vite skips under server.https", () => {
    for (const host of ['localhost', 'localhost:4400', 'app.localhost:4400', '127.0.0.1:4400', '[::1]:4400', '192.168.1.10:4400']) {
      expect(run('/@trivia/api/health', { headers: { host } }).status, host).toBe('next')
    }
    for (const host of ['evil.example', 'evil.example:4400', 'localhost.evil.example', 'localhost.', 'x@localhost', '[::1', '']) {
      const r = run('/@trivia/api/health', { headers: { host } })
      expect([r.status, r.code], JSON.stringify(host)).toEqual([403, 'forbidden'])
    }
    expect(run('/@trivia/api/health', { headers: {} }).message).toContain('host (none)')
    const allowedHosts = ['dev.example', '.corp.example']
    for (const host of ['dev.example', 'corp.example:4400', 'a.corp.example']) {
      expect(run('/@trivia/api/health', { headers: { host }, allowedHosts }).status, host).toBe('next')
    }
    expect(run('/@trivia/api/health', { headers: { host: 'evil.example' }, allowedHosts: true }).status).toBe('next')
  })

  it("follows the plugin's Origin rule", () => {
    const host = 'localhost:4400'
    for (const origin of ['http://localhost:4400', 'http://127.0.0.1:5173', 'https://[::1]:4400']) {
      expect(run('/@trivia/api/apply', { headers: { host, origin } }).status, origin).toBe('next')
    }
    for (const origin of ['null', 'http://evil.example', 'http://localhost.evil.example', 'file://', 'chrome-extension://abc']) {
      const r = run('/@trivia/api/apply', { headers: { host, origin } })
      expect([r.status, r.code], origin).toEqual([403, 'forbidden'])
    }
  })

  it('is mounted on the preview server too, which proxies the same way', () => {
    type Use = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void
    const used: Use[] = []
    const hook = apiGuard().configurePreviewServer as unknown as (server: unknown) => void
    hook({ middlewares: { use: (fn: Use) => used.push(fn) }, config: { preview: { allowedHosts: [] } } })
    expect(used).toHaveLength(1)
    let status = 0
    const res = {
      setHeader() {},
      end() {},
      set statusCode(code: number) {
        status = code
      },
    } as unknown as http.ServerResponse
    const lan = { url: '/@trivia/api/health', headers: { host: 'localhost' }, socket: { remoteAddress: '192.168.1.66' } }
    used[0]?.(lan as unknown as http.IncomingMessage, res, () => {})
    expect(status).toBe(403)
  })
})

describe('isApiPath', () => {
  it('reads a path as the proxy and then the plugin will', () => {
    for (const url of [
      '/@trivia/api',
      '/@trivia/api/health?x=1',
      '/x/%2e%2e/@trivia/api/apply',
      '//evil.example/@trivia/api/apply',
      '/x/..//evil.example/@trivia/api/apply',
      '/%2E//evil.example/@trivia/api/apply',
      '///evil.example/@trivia/api/apply',
      '/\\evil.example/@trivia/api/apply',
      '//[bad', // unparseable: refused rather than guessed
    ]) {
      expect(isApiPath(url), url).toBe(true)
    }
    for (const url of ['/', '/src/App.tsx', '/@trivia/apiary', '/%40trivia/api/apply', '//@trivia/api/apply', '/__trivia/']) {
      expect(isApiPath(url), url).toBe(false)
    }
  })

  it('is what the proxy bypass refuses, for upgrades only', () => {
    const req = { url: '/@trivia/api/components' } as http.IncomingMessage
    expect(isApiUpgrade(req, undefined)).toBe(true)
    expect(isApiUpgrade(req, {} as http.ServerResponse)).toBe(false) // plain HTTP: apiGuard's job
    expect(isApiUpgrade({ url: '/__trivia/' } as http.IncomingMessage, undefined)).toBe(false)
  })
})
