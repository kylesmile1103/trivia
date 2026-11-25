import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

async function upstream(name: string) {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '')
    req.resume()
    res.end(name)
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('FR-TN-03: designer with a separate dev service', () => {
  let app: Awaited<ReturnType<typeof upstream>>
  let api: Awaited<ReturnType<typeof upstream>>
  let designer: ViteDevServer
  let url: string

  beforeAll(async () => {
    app = await upstream('app')
    api = await upstream('api')
    vi.stubEnv('TRIVIA_TARGET', app.url)
    vi.stubEnv('TRIVIA_API_TARGET', api.url)
    designer = await createServer({
      configFile: path.join(import.meta.dirname, '..', 'vite.config.ts'),
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: true, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
    await designer.listen()
    url = `http://127.0.0.1:${(designer.httpServer!.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await designer?.close()
    await Promise.all([app?.close(), api?.close()])
  })

  it('proxies only the named Trivia endpoints to the dev service', async () => {
    for (const [route, target] of [
      ['/@trivia/api/health', 'api'],
      ['/@trivia/mcp?test=1', 'api'],
      ['/@trivia/preview/component.tsx', 'app'],
      ['/@trivia/apiary', 'app'],
      ['/_next/static/app.js', 'app'],
      ['/customers', 'app'],
    ]) {
      expect(await (await fetch(`${url}${route}`)).text(), route).toBe(target)
    }
  })

  it('refuses a foreign origin before either target receives the request', async () => {
    const before = [app.requests.length, api.requests.length]
    for (const route of ['/@trivia/api/health', '/@trivia/mcp']) {
      const res = await fetch(`${url}${route}`, { headers: { origin: 'https://foreign.example' } })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect([app.requests.length, api.requests.length]).toEqual(before)
  })
})
