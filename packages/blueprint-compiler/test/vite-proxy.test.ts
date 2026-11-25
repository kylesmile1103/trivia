import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const example = path.resolve(import.meta.dirname, '../../../examples/refine-admin')
const template = path.resolve(import.meta.dirname, '../templates/vite-refine/vite.config.ts.template')
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-vite-proxy-'))
  fs.copyFileSync(template, path.join(root, 'vite.config.ts'))
  fs.symlinkSync(path.join(example, 'node_modules'), path.join(root, 'node_modules'), 'junction')
  for (const name of ['services__api__https__0', 'services__api__http__0', 'API_URL', 'PORT']) vi.stubEnv(name, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

async function serverOptions() {
  const resolved = createRequire(path.join(example, 'package.json')).resolve('vite')
  const { loadConfigFromFile } = await import(pathToFileURL(resolved).href)
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(root, 'vite.config.ts'), root)
  return loaded.config.server
}

it('FR-AS-07 prefers the discovered HTTPS endpoint and binds the port assigned by Aspire', async () => {
  vi.stubEnv('services__api__https__0', 'https://api.test:7001')
  vi.stubEnv('services__api__http__0', 'http://api.test:7000')
  vi.stubEnv('API_URL', 'http://fallback.test:7002')
  vi.stubEnv('PORT', '5435')

  const config = await serverOptions()
  const proxy = config.proxy['^/api(?:/|\\?|$)']
  expect(config).toMatchObject({ port: 5435, strictPort: true })
  expect(proxy).toMatchObject({ target: 'https://api.test:7001', changeOrigin: true })
  expect(proxy.rewrite).toBeUndefined()
})

it('tries the discovered HTTP endpoint, then API_URL', async () => {
  vi.stubEnv('services__api__http__0', 'http://api.test:7000')
  vi.stubEnv('API_URL', 'http://fallback.test:7002')
  expect(Object.values((await serverOptions()).proxy)).toEqual([{ target: 'http://api.test:7000', changeOrigin: true }])
  vi.stubEnv('services__api__http__0', undefined)
  expect(Object.values((await serverOptions()).proxy)).toEqual([{ target: 'http://fallback.test:7002', changeOrigin: true }])
})

it('answers the first API request with configuration help when no endpoint is set', async () => {
  const config = await serverOptions()
  const route = Object.keys(config.proxy)[0]!
  expect(new RegExp(route).test('/api/v1/customers')).toBe(true)
  expect(new RegExp(route).test('/api?resource=customers')).toBe(true)
  expect(new RegExp(route).test('/apiary')).toBe(false)
  expect(config.port).toBeUndefined()

  const end = vi.fn()
  const writeHead = vi.fn(() => ({ end }))
  const request = { url: '/api/v1/customers' }
  expect(config.proxy[route].bypass(request, { writeHead })).toBe(request.url)
  expect(writeHead).toHaveBeenCalledWith(503, { 'content-type': 'application/problem+json' })
  expect(JSON.parse(String(end.mock.calls[0]?.[0])).detail).toContain('API_URL')
})
