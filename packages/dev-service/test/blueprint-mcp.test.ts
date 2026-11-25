import fs from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { createStandaloneHost, startDevService, type RunningDevService } from '../src/standalone.js'
import { copyBlueprintProject, listPage } from './blueprint-fixture.js'

let root: string
let running: RunningDevService
let client: Client

beforeEach(async () => {
  root = copyBlueprintProject()
  running = await startDevService(createStandaloneHost(root))
  client = new Client({ name: 'blueprint-test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL('/@trivia/mcp', running.url)) as unknown as Transport)
})

afterEach(async () => {
  await client?.close()
  await running?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

async function tool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return await client.callTool({ name, arguments: args }) as CallToolResult
}

it('FR-AG-02 shares blueprint reads and writes between MCP and HTTP', async () => {
  expect((await tool('trivia_blueprint_get')).structuredContent).toMatchObject({ exists: false, next: expect.stringContaining('createPage') })
  const page = listPage()
  const result = await tool('trivia_blueprint_patch', { ops: [page], label: 'Add customers' })
  expect(result).toMatchObject({ structuredContent: { entry: 'Agent: Add customers', summary: { pages: [{ name: 'Customers', errors: 0 }] } } })
  const doc = await tool('trivia_blueprint_get', { what: 'doc', path: page.doc, projection: true })
  expect(doc.structuredContent).toMatchObject({ path: page.doc, doc: { name: 'Customers' }, projection: expect.stringContaining('Customers') })
  const http = await fetch(`${running.url}/@trivia/api/blueprint/doc?path=${page.doc}&projection=1`)
  expect(await http.json()).toEqual({ ok: true, data: doc.structuredContent })
})

it('FR-AG-04 sends blueprint refusal details and tool-specific next steps as structured data', async () => {
  const doc = await tool('trivia_blueprint_get', { what: 'doc', path: '../outside.json' })
  expect(doc).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'path_outside_root' }, next: expect.stringContaining('blueprint directory') },
  })
  const page = listPage()
  await tool('trivia_blueprint_patch', { label: 'Create', ops: [page] })
  const stale = await tool('trivia_blueprint_patch', { label: 'Stale', ops: [page] })
  expect(stale).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: 'conflict', details: { revs: { [page.doc]: expect.stringMatching(/^sha256:/) } } },
      next: expect.stringContaining('trivia_blueprint_get'),
    },
  })
})
