// Test fixtures: temp copies of examples/playground, and real Vite dev servers (middleware
// mode, no HMR socket, no watcher) reached over a Unix socket so no TCP port is taken.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createServer, type ServerOptions, type ViteDevServer } from 'vite'

import astLocator, { type AstLocatorOptions } from '../src/index.js'

/**
 * Test-only request header naming the client address the server sees. A Unix socket has no
 * remote address (which the API refuses), so by default the harness stands in for a loopback
 * TCP client, 127.0.0.1. `none` leaves the address undefined, as a real Unix socket does.
 */
export const REMOTE = 'x-test-remote-address'

/** Headers that make a request look like it comes from `address`. */
export const from = (address: string, headers: Record<string, string> = {}): Record<string, string> => ({
  [REMOTE]: address,
  ...headers,
})

export const PLAYGROUND = path.resolve(import.meta.dirname, '../../../examples/playground')

const COPIED = ['src', 'index.html', 'components.json', 'package.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']

/** A throwaway copy of the playground (sources only; node_modules is a symlink). */
export function copyPlayground(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-plugin-'))
  for (const entry of COPIED) fs.cpSync(path.join(PLAYGROUND, entry), path.join(dir, entry), { recursive: true })
  fs.symlinkSync(path.join(PLAYGROUND, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  return dir
}

export interface TestServer {
  vite: ViteDevServer
  socket: string
  close(): Promise<void>
}

export async function startServer(
  root: string,
  options: AstLocatorOptions = {},
  server: ServerOptions = {},
): Promise<TestServer> {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    cacheDir: path.join(root, '.vite'),
    plugins: [astLocator(options)],
    resolve: { alias: { '@': path.join(root, 'src') } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...server, middlewareMode: true, ws: false, watch: null },
  })
  const socket = path.join(os.tmpdir(), `trivia-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
  const httpServer = http.createServer((req, res) => {
    const named = req.headers[REMOTE]
    delete req.headers[REMOTE]
    const address = typeof named !== 'string' ? '127.0.0.1' : named === 'none' ? undefined : named
    // Set on every request: the global agent keeps sockets alive across requests.
    Object.defineProperty(req.socket, 'remoteAddress', { value: address, configurable: true })
    vite.middlewares(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(socket, resolve)
  })
  return {
    vite,
    socket,
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      await vite.close()
      fs.rmSync(socket, { force: true })
    },
  }
}

export interface Reply {
  status: number
  body: any
}

export interface RequestOptions {
  method?: string
  /** Sent as JSON unless it is already a string. */
  body?: unknown
  headers?: Record<string, string>
  /** false sends no Host header at all (Node adds one by default). */
  setHost?: boolean
}

export function request(socket: string, url: string, options: RequestOptions = {}): Promise<Reply> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST')
  const payload =
    options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  const headers: Record<string, string> = {
    ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    ...options.headers,
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: url, method, headers, setHost: options.setHost ?? true }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = text
        try {
          body = JSON.parse(text)
        } catch {
          // non-JSON (e.g. Vite's own 404): keep the text
        }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** POST a JSON body to the engine API. */
export function post(socket: string, endpoint: string, body: unknown = {}, headers?: Record<string, string>): Promise<Reply> {
  return request(socket, `/@trivia/api${endpoint}`, { method: 'POST', body, ...(headers ? { headers } : {}) })
}

export function get(socket: string, endpoint: string, headers?: Record<string, string>): Promise<Reply> {
  return request(socket, `/@trivia/api${endpoint}`, headers ? { headers } : {})
}

/**
 * A `fetch` that reaches the test server's Unix socket, for clients that only speak URLs (the
 * MCP SDK's). `extra` headers go on every request (`from(…)` to pose as another machine).
 */
export function socketFetch(socket: string, extra: Record<string, string> = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    for (const [name, value] of Object.entries(extra)) headers.set(name, value)
    const body = init?.body == null ? undefined : Buffer.from(await new Response(init.body).arrayBuffer())
    return new Promise<Response>((resolve, reject) => {
      const req = http.request(
        { socketPath: socket, path: url.pathname + url.search, method: init?.method ?? 'GET', headers: Object.fromEntries(headers) },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const status = res.statusCode ?? 0
            const responseHeaders = new Headers()
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
            }
            const empty = status === 204 || status === 205 || status === 304
            resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: responseHeaders }))
          })
        },
      )
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })
  }) as typeof fetch
}
