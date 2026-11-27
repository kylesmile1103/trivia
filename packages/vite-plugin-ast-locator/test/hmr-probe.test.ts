import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { createServer, type ViteDevServer } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HMR_PROBE_ID, HMR_PROBE_URL, HMR_READY } from '../src/hmr-probe.js'
import astLocator from '../src/index.js'
import { RECHECK_MS } from '../src/watch.js'
import { copyPlayground, request, startServer } from './helpers.js'

// The probe a Vite canvas document's catch-up waits for (LLD-13 §6): the page sends HMR_READY
// once its HMR socket is open, and the server answers that socket alone.

let root: string
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const PROBE_TAG = `<script type="module" src="${HMR_PROBE_URL}"></script>`

/**
 * A dev server on a playground copy that serves its index.html and has an HMR socket, both on
 * one loopback port (the helpers' servers have neither).
 */
async function socketServer(): Promise<{ vite: ViteDevServer; origin: string; close(): Promise<void> }> {
  root = copyPlayground()
  let vite: ViteDevServer | undefined
  const httpServer = http.createServer((req, res) => vite!.middlewares(req, res))
  vite = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'spa',
    cacheDir: path.join(root, '.vite'),
    plugins: [astLocator()],
    resolve: { alias: { '@': path.join(root, 'src') } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, ws: { server: httpServer }, watch: null },
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  const { port } = httpServer.address() as AddressInfo
  return {
    vite,
    origin: `127.0.0.1:${port}`,
    async close() {
      await vite!.close()
      httpServer.closeAllConnections()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}

/** A page's HMR socket, as Vite's client opens it, and every message it received, in order. */
async function hmrSocket(vite: ViteDevServer, origin: string) {
  const socket = new WebSocket(`ws://${origin}/?token=${vite.config.webSocketToken}`, 'vite-hmr')
  const received: Array<{ type: string; event?: string }> = []
  socket.addEventListener('message', (message) => received.push(JSON.parse(String(message.data))))
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  await vi.waitFor(() => expect(received).toEqual([{ type: 'connected' }]))
  return {
    received,
    ask: () => socket.send(JSON.stringify({ type: 'custom', event: HMR_READY })),
    close: () => socket.close(),
  }
}

describe('the HMR probe', () => {
  it('is in the head of the page the server serves, before the app’s entry, and runs over import.meta.hot', async () => {
    const server = await socketServer()
    try {
      const html = await (await fetch(`http://${server.origin}/`)).text()
      const head = html.slice(0, html.indexOf('</head>'))
      expect(head).toContain(PROBE_TAG)
      expect(html.match(/trivia:hmr-ready/g)).toHaveLength(1)
      expect(html.indexOf(PROBE_TAG)).toBeLessThan(html.indexOf('/src/main.tsx'))

      const probe = await (await fetch(`http://${server.origin}${HMR_PROBE_URL}`)).text()
      expect(probe).toContain('import.meta.hot = __vite__createHotContext(')
      expect(probe).toContain('window.__TRIVIA_HMR__ = probe')
      expect(probe).toContain('import.meta.hot.send("trivia:hmr-ready")')
      expect(probe).not.toContain('data-ast-node')
    } finally {
      await server.close()
    }
  })

  it('answers the socket that asks, and no other', async () => {
    const server = await socketServer()
    try {
      const [asking, other] = [await hmrSocket(server.vite, server.origin), await hmrSocket(server.vite, server.origin)]
      asking.ask()
      await vi.waitFor(() => expect(asking.received).toEqual([{ type: 'connected' }, { type: 'custom', event: HMR_READY }]))
      // The other socket asks only after the first one's answer arrived: an answer sent to every
      // socket would have reached it first.
      other.ask()
      await vi.waitFor(() => expect(other.received).toEqual([{ type: 'connected' }, { type: 'custom', event: HMR_READY }]))
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(asking.received).toHaveLength(2)
      expect(other.received).toHaveLength(2)
      asking.close()
      other.close()
    } finally {
      await server.close()
    }
  })

  it('is not on the page without the API', async () => {
    root = copyPlayground()
    const server = await startServer(root, { api: false })
    try {
      const html = await server.vite.transformIndexHtml('/', fs.readFileSync(path.join(root, 'index.html'), 'utf8'))
      expect(html).not.toContain(HMR_READY)
      expect(html).toContain('/@vite/client') // the transform ran
    } finally {
      await server.close()
    }
  })

  // `invalidatePreviews` reloads the page for any loaded module under src/.trivia-preview/ but
  // the blueprint entry. A probe there would reload every canvas on every sync and blueprint write.
  it('loaded, it is no preview: a manifest change reloads nothing for it', async () => {
    root = copyPlayground()
    const server = await startServer(root)
    try {
      expect((await request(server.socket, HMR_PROBE_URL)).status).toBe(200)
      const probe = server.vite.environments.client.moduleGraph.getModuleById(HMR_PROBE_ID)
      expect(probe?.transformResult).not.toBeNull()
      const sent: unknown[] = []
      for (const hot of [server.vite.environments.client.hot, server.vite.hot]) {
        vi.spyOn(hot, 'send').mockImplementation((payload: unknown) => { sent.push(payload) })
      }
      // As the watcher reports it: under the root Vite resolved (macOS's temp directory is behind /var).
      const manifest = path.join(server.vite.config.root, 'trivia.manifest.json')
      server.vite.watcher.emit('all', 'change', manifest, fs.statSync(manifest))
      await new Promise((resolve) => setTimeout(resolve, 3 * RECHECK_MS))
      expect(sent).toEqual([])
      expect(probe?.transformResult).not.toBeNull()
    } finally {
      await server.close()
    }
  })
})
