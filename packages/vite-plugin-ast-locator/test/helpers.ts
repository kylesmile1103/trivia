// Test fixtures: temp copies of examples/playground, and real Vite dev servers (middleware
// mode, no HMR socket, no watcher) reached over a Unix socket so no TCP port is taken.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createServer, type ViteDevServer } from 'vite'

import astLocator, { type AstLocatorOptions } from '../src/index.js'

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

export async function startServer(root: string, options: AstLocatorOptions = {}): Promise<TestServer> {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    cacheDir: path.join(root, '.vite'),
    plugins: [astLocator(options)],
    resolve: { alias: { '@': path.join(root, 'src') } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, ws: false, watch: null },
  })
  const socket = path.join(os.tmpdir(), `trivia-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
  const httpServer = http.createServer(vite.middlewares)
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
    const req = http.request({ socketPath: socket, path: url, method, headers }, (res) => {
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
