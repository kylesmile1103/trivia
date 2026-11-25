import fs from 'node:fs'
import path from 'node:path'

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

it('FR-AG-02 lists blueprint tools and their guarded input shapes', async () => {
  const { tools } = await client.listTools()
  const blueprint = tools.filter(({ name }) => name.startsWith('trivia_blueprint_'))
  expect(blueprint.map(({ name, inputSchema, annotations }) => ({
    name,
    arguments: Object.keys(inputSchema.properties ?? {}).sort(),
    required: [...inputSchema.required ?? []].sort(),
    readOnly: annotations?.readOnlyHint,
  }))).toMatchSnapshot()
  const patch = blueprint.find(({ name }) => name === 'trivia_blueprint_patch')
  const { items, minItems } = patch?.inputSchema.properties?.ops as {
    minItems: number
    items: { oneOf?: OperationSchema[]; anyOf?: OperationSchema[] }
  }
  expect(minItems).toBe(1)
  const ops = items.oneOf ?? items.anyOf!
  expect(ops.map(({ properties, required }) => ({ op: properties.op.const, required }))).toMatchSnapshot()
})

interface OperationSchema {
  properties: { op: { const: string } }
  required: string[]
}

it('FR-AG-04 scripts an MCP-only authoring loop for two pages and fixes the diagnostics', async () => {
  const first = listPage()
  const second = listPage('Accounts', 'MissingAccounts')
  const result = await tool('trivia_blueprint_patch', {
    label: 'Draft bank pages',
    ops: [
      { op: 'setApp', doc: 'app.blueprint.json', baseRev: null, name: 'Bank', targets: { web: 'vite-refine' } },
      first, second,
    ],
  })
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toMatchObject({
    diagnostics: [{ code: 'unknown_resource', doc: second.doc, hint: { text: expect.stringContaining('Account') } }],
    summary: { pages: [{ name: 'Accounts', errors: 1 }, { name: 'Customers', errors: 0 }] },
  })

  const { structuredContent: doc } = await tool('trivia_blueprint_get', { what: 'doc', path: second.doc })
  const fixed = await tool('trivia_blueprint_patch', {
    label: 'Use the account resource',
    ops: [{ op: 'setPageMeta', doc: second.doc, baseRev: doc?.rev, resource: 'Account' }],
  })
  expect(fixed.isError).not.toBe(true)
  expect(fixed.structuredContent).toMatchObject({
    diagnostics: [],
    summary: { app: { name: 'Bank' }, pages: [{ name: 'Accounts', errors: 0 }, { name: 'Customers', errors: 0 }] },
  })
  const summary = await tool('trivia_blueprint_get')
  expect(summary.structuredContent).toEqual(fixed.structuredContent?.summary)
})

it('FR-AG-03 restores a labelled patch byte for byte and refuses undo over a hand edit', async () => {
  const app = 'app.blueprint.json'
  const page = listPage()
  const setup = await tool('trivia_blueprint_patch', {
    label: 'Create the bank',
    ops: [{ op: 'setApp', doc: app, baseRev: null, name: 'Bank', targets: { web: 'vite-refine' } }, page],
  })
  expect(setup.isError).not.toBe(true)
  const files = [app, page.doc].map((file) => path.join(root, 'blueprint', file))
  const originals = files.map((file) => {
    const text = fs.readFileSync(file, 'utf8').replaceAll('\n', '\r\n') + '\r\n'
    fs.writeFileSync(file, text)
    return Buffer.from(text)
  })
  const drafts = await tool('trivia_blueprint_get')
  const summary = drafts.structuredContent as { app: { rev: string }; pages: [{ rev: string }] }
  const args = {
    label: 'Update both documents',
    ops: [
      { op: 'setApp', doc: app, baseRev: summary.app.rev, name: 'BackOffice' },
      { op: 'setPageMeta', doc: page.doc, baseRev: summary.pages[0].rev, resource: 'Account' },
    ],
  }
  const updated = await tool('trivia_blueprint_patch', args)
  const entry = 'Agent: Update both documents'
  expect(updated).toMatchObject({ structuredContent: { entry, changed: true } })
  expect((await tool('trivia_get_selection')).structuredContent).toMatchObject({ history: { undoLabel: entry } })
  expect(files.map((file) => fs.readFileSync(file))).not.toEqual(originals)
  expect((await tool('trivia_undo', { label: entry })).isError).not.toBe(true)
  expect(files.map((file) => fs.readFileSync(file))).toEqual(originals)

  expect((await tool('trivia_blueprint_patch', args)).isError).not.toBe(true)
  fs.appendFileSync(files[1]!, '\n')
  const edited = files.map((file) => fs.readFileSync(file))
  const refused = await tool('trivia_undo', { label: entry })
  expect(refused.isError).toBe(true)
  expect(refused.content).toEqual([expect.objectContaining({ text: expect.stringContaining('conflict') })])
  expect(files.map((file) => fs.readFileSync(file))).toEqual(edited)
  expect((await tool('trivia_get_selection')).structuredContent).toMatchObject({ history: { undoLabel: entry } })
})

it.each([
  ['trivia_blueprint_preview', { page: 'Customers' }, '005'],
  ['trivia_blueprint_eject', { pages: ['Customers'], label: 'Eject customers' }, '005'],
  ['trivia_blueprint_backend', { mode: 'plan' }, '009'],
])('FR-AG-02 reserves %s with a structured unavailable response', async (name, args, spec) => {
  const result = await tool(name, args)
  expect(result).toMatchObject({
    isError: true, structuredContent: {
      error: { code: 'unsupported', message: expect.stringContaining(`spec ${spec}`) },
      next: expect.stringContaining(`spec ${spec}`),
    },
  })
  expect(fs.existsSync(path.join(root, 'blueprint'))).toBe(false)
})
