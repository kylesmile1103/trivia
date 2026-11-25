// GET /routes and MCP trivia_list_routes on a copy of the Refine example: the plugin's Vite
// resolver names each page's module through the app's `@/` alias, and <Refine resources> labels
// the routes it declares. The playground has no router: no routes.

import fs from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AppRoute } from '@trivia/dev-service'
import { copyPlayground, copyRefineAdmin, get, socketFetch, startServer, type TestServer } from './helpers.js'

let root: string
let server: TestServer

beforeAll(async () => {
  root = copyRefineAdmin()
  server = await startServer(root)
})

afterAll(async () => {
  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('GET /routes', () => {
  it("lists refine-admin's pages: URL, component, module, Refine resource and action", async () => {
    const reply = await get(server.socket, '/routes')
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    const routes = (reply.body as { data: AppRoute[] }).data
    expect(routes.map((r) => [r.path, r.component, r.file, r.resource && `${r.resource.name}.${r.resource.action}`])).toEqual([
      ['/', 'NavigateToResource', null, null],
      ['/customers', 'CustomerList', 'src/pages/customers/list.tsx', 'customers.list'],
      ['/customers/create', 'CustomerCreate', 'src/pages/customers/create.tsx', 'customers.create'],
      ['/customers/edit/:id', 'CustomerEdit', 'src/pages/customers/edit.tsx', 'customers.edit'],
      ['/accounts', 'AccountList', 'src/pages/accounts/list.tsx', 'accounts.list'],
      ['/transactions', 'TransactionList', 'src/pages/transactions/list.tsx', 'transactions.list'],
      ['/transactions/show/:id', 'OpenApiShowInferencer', null, 'transactions.show'],
      ['/*', 'ErrorComponent', 'src/components/refine-ui/layout/error-component.tsx', null],
    ])
    expect(routes[3]).toMatchObject({ params: ['id'], router: 'react-router', declared: { file: 'src/App.tsx' } })
    expect(routes[3]!.locator).toMatch(/^src\/App\.tsx#App#/)
  })

  it('is empty for an app without a router', async () => {
    const playground = copyPlayground()
    const other = await startServer(playground)
    try {
      const reply = await get(other.socket, '/routes')
      expect(reply.body).toEqual({ ok: true, data: [] })
    } finally {
      await other.close()
      fs.rmSync(playground, { recursive: true, force: true })
    }
  })
})

describe('MCP trivia_list_routes', () => {
  it('gives an agent the same routes, and a line per route', async () => {
    const client = new Client({ name: 'routes-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/@trivia/mcp'), { fetch: socketFetch(server.socket) }) as unknown as Transport)
    try {
      const result = (await client.callTool({ name: 'trivia_list_routes', arguments: {} })) as unknown as {
        content: Array<{ text?: string }>
        structuredContent: { routes: AppRoute[] }
      }
      expect(result.structuredContent.routes.map((r) => r.path)).toContain('/customers/edit/:id')
      expect(result.content[0]!.text).toContain('/customers/edit/:id (customers edit)  <CustomerEdit> src/pages/customers/edit.tsx')
    } finally {
      await client.close()
    }
  })
})
