import fs from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { expect, it } from 'vitest'

import { copyRefineAdmin, from, get, post, socketFetch, startServer } from './helpers.js'

const remote = from('192.0.2.10')

it('NFR-05 keeps each blueprint endpoint on loopback even when Vite allows remote source editing', async () => {
  const root = copyRefineAdmin()
  const server = await startServer(root, { allowRemote: true })
  try {
    expect((await get(server.socket, '/health', remote)).status).toBe(200)
    for (const route of ['/blueprint', '/blueprint/doc', '/blueprint/components']) {
      const reply = await get(server.socket, route, remote)
      expect([reply.status, reply.body.error?.code], route).toEqual([403, 'forbidden'])
    }
    for (const action of ['patch', 'preview', 'plan', 'ejected', 'backend']) {
      const reply = await post(server.socket, `/blueprint/${action}`, {}, remote)
      expect([reply.status, reply.body.error?.code], action).toEqual([403, 'forbidden'])
    }

    const client = new Client({ name: 'remote-vite-test', version: '0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/@trivia/mcp'),
        { fetch: socketFetch(server.socket, remote) }) as unknown as Transport)
      const names = (await client.listTools()).tools.map(({ name }) => name)
      expect(names).toContain('trivia_get_selection')
      expect(names.filter((name) => name.startsWith('trivia_blueprint_'))).toEqual([])
      expect((await client.callTool({ name: 'trivia_blueprint_get' })).isError).toBe(true)
    } finally {
      await client.close()
    }
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
