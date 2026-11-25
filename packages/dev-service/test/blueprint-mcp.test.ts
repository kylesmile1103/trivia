import fs from 'node:fs'
import path from 'node:path'

import { MODEL_DOC, modelOpSchema, revOfText } from '@trivia/blueprint'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

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
  properties: { op: { const: string }; doc?: { const: string }; targets?: { description?: string } }
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

it('FR-AG-02 explains how to enable preview on the standalone host', async () => {
  const result = await tool('trivia_blueprint_preview', { page: 'Customers' })
  expect(result).toMatchObject({
    isError: true, structuredContent: {
      error: { code: 'unsupported', message: expect.stringContaining('running Vite app host') },
      next: expect.stringContaining('Vite Refine app host'),
    },
  })
  expect(fs.existsSync(path.join(root, 'blueprint'))).toBe(false)
})

it('ejects and undoes generated source and lock in one Agent entry', async () => {
  const draft = { ...listPage('DraftEject'), kind: 'custom', route: '/draft-eject', resource: undefined }
  expect((await tool('trivia_blueprint_patch', { ops: [draft], label: 'Draft' })).isError).not.toBe(true)
  const app = path.join(root, 'src/App.tsx')
  const before = fs.readFileSync(app)
  const entry = 'Agent: Eject draft'
  const result = await tool('trivia_blueprint_eject', { pages: [draft.name], label: 'Eject draft' })
  expect(result).toMatchObject({ structuredContent: { entry, files: [expect.stringMatching(/DraftEject\.tsx$/)] } })
  const [file] = result.structuredContent!.files as string[]
  const lock = path.join(root, 'blueprint/blueprint.lock.json')
  expect(fs.readFileSync(path.join(root, file!), 'utf8')).toContain('function DraftEject')
  expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pages).toHaveProperty(draft.name)
  expect((await tool('trivia_undo', { label: entry })).isError).not.toBe(true)
  expect(fs.readFileSync(app)).toEqual(before)
  expect(fs.existsSync(path.join(root, file!))).toBe(false)
  expect(fs.existsSync(lock)).toBe(false)
})

it.each([true, false])('plans safe nav and theme edits with theme anchor=%s', async (anchor) => {
  const app = path.join(root, 'src/App.tsx')
  if (anchor) fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace('</Refine>', '<style id="trivia-theme" />\n      </Refine>'))
  const draft = { ...listPage('AccountDraft', 'Account'), kind: 'show', route: '/draft-account/:id' }
  expect((await tool('trivia_blueprint_patch', { label: 'Draft', ops: [
    draft,
    { op: 'setApp', doc: 'app.blueprint.json', baseRev: null, name: 'Bank', targets: { web: 'vite-refine' }, theme: { tokens: { radius: '6px' } } },
    { op: 'setNav', doc: 'app.blueprint.json', baseRev: null, nav: [{ page: draft.name, label: 'Bank accounts', icon: 'landmark' }] },
  ] })).isError).not.toBe(true)
  const result = await tool('trivia_blueprint_eject', { pages: [draft.name], label: 'Decorate' })
  expect(result.structuredContent).toMatchObject({ entry: 'Agent: Decorate', warnings: expect.arrayContaining([expect.stringContaining('icon')]) })
  const source = fs.readFileSync(app, 'utf8')
  expect(source).toContain('label: "Bank accounts"')
  expect(source).toContain('icon: <LandmarkIcon />')
  if (anchor) expect(source).toContain('--radius: 6px;')
  else expect(result.structuredContent?.warnings).toEqual(expect.arrayContaining([expect.stringContaining('trivia-theme')]))
})

it('NFR-14 executes the documented blueprint authoring calls', async () => {
  const docs = fs.readFileSync(new URL('../../../docs/mcp.md', import.meta.url), 'utf8')
  const section = docs.split(/^## Blueprint authoring$/m)[1]!
  const examples = [...section.matchAll(/^```json\n([\s\S]*?)\n^```$/gm)].map(([, json]) =>
    JSON.parse(json!) as { name: string; arguments: Record<string, unknown> })
  const names = examples.map(({ name, arguments: args }) => args.what ? `${name}/${args.what}` : name)
  async function call(name: string) {
    const example = examples[names.indexOf(name)]
    expect(example, name).toBeDefined()
    return tool(example!.name, example!.arguments)
  }

  expect(names).toHaveLength(7)
  expect(new Set(names)).toEqual(new Set([
    'trivia_blueprint_get/summary', 'trivia_blueprint_get/components', 'trivia_blueprint_get/doc',
    'trivia_blueprint_patch', 'trivia_blueprint_preview', 'trivia_blueprint_eject', 'trivia_blueprint_backend',
  ]))
  expect((await call('trivia_blueprint_get/summary')).structuredContent).toMatchObject({ exists: false })
  expect((await call('trivia_blueprint_get/components')).structuredContent).toMatchObject({ schemas: { Button: { type: 'object' } } })
  expect((await call('trivia_blueprint_patch')).structuredContent).toMatchObject({ entry: 'Agent: Add customers', summary: { pages: [{ errors: 0 }] } })
  expect((await call('trivia_blueprint_get/doc')).structuredContent).toMatchObject({ doc: { name: 'Customers' }, projection: expect.stringContaining('Customers') })
  expect(await call('trivia_blueprint_preview')).toMatchObject({ isError: true, structuredContent: { error: { code: 'unsupported' } } })
  expect(await call('trivia_blueprint_eject')).toMatchObject({ isError: true, structuredContent: { error: { code: 'conflict' } } })
  vi.stubEnv('PATH', root)
  try {
    expect(await call('trivia_blueprint_backend')).toMatchObject({
      isError: true, structuredContent: { error: { code: 'unsupported', details: { hint: expect.stringContaining('.NET 10 SDK') } } },
    })
  } finally {
    vi.unstubAllEnvs()
  }
})

it('SC-001 tells a first-time author that creating the app requires a web target', async () => {
  const summary = await tool('trivia_blueprint_get')
  expect(summary.structuredContent).toMatchObject({ next: expect.stringContaining('targets.web') })
  const { tools } = await client.listTools()
  const patch = tools.find(({ name }) => name === 'trivia_blueprint_patch')
  const { items } = patch?.inputSchema.properties?.ops as {
    items: { oneOf?: OperationSchema[]; anyOf?: OperationSchema[] }
  }
  const setApp = (items.oneOf ?? items.anyOf)!.find(({ properties }) => properties.op.const === 'setApp')
  expect(setApp?.properties.targets?.description).toContain('required when baseRev is null')
})

it('FR-DM-07 advertises model payloads and summarizes a patched model with its disk revision', async () => {
  const { tools } = await client.listTools()
  const patch = tools.find(({ name }) => name === 'trivia_blueprint_patch')
  const { items } = patch?.inputSchema.properties?.ops as {
    items: { oneOf?: OperationSchema[]; anyOf?: OperationSchema[] }
  }
  const variants = (items.oneOf ?? items.anyOf ?? []).filter(({ properties }) => properties.doc?.const === MODEL_DOC)
  expect(variants.map(({ properties }) => properties.op.const)).toEqual(modelOpSchema.options.map((schema) => schema.shape.op.value))

  const initial = await tool('trivia_blueprint_patch', {
    label: 'Model two entities',
    ops: [
      { op: 'setModel', doc: MODEL_DOC, baseRev: null, namespace: 'Bank' },
      ...['Customer', 'Account'].map((name) => ({
        op: 'setEntity', doc: MODEL_DOC, baseRev: null, entity: {
          name, plural: name.toLowerCase() + 's', key: { name: 'id', type: 'uuid' },
        },
      })),
    ],
  })
  expect(initial.isError).not.toBe(true)
  const rev = revOfText(fs.readFileSync(path.join(root, 'blueprint', MODEL_DOC), 'utf8'))
  const entities = ['Customer', 'Account']
  expect(initial.structuredContent).toMatchObject({
    revs: { [MODEL_DOC]: rev }, summary: { model: { rev, entities } },
  })
  expect((await tool('trivia_blueprint_get')).structuredContent).toMatchObject({ model: { rev, entities } })
  expect((await tool('trivia_blueprint_get', { what: 'doc', path: MODEL_DOC })).structuredContent).toMatchObject({
    rev, doc: { namespace: 'Bank', entities: entities.map((name) => ({ name })) },
  })
  expect(Object.fromEntries(variants.map(({ properties }) => [
    properties.op.const, Object.keys(properties).filter((key) => !['op', 'doc', 'baseRev'].includes(key)).sort(),
  ]))).toMatchSnapshot()
})

it('FR-AG-06 returns a loadable blueprint preview and optional code over MCP', async () => {
  await client.close()
  await running.close()
  const host = createStandaloneHost(root)
  running = await startDevService({
    ...host,
    preview: { blueprints: true, publish: (id) => '/@trivia/preview/' + id + '.tsx' },
  }, { port: 0 })
  client = new Client({ name: 'blueprint-preview-test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL('/@trivia/mcp', running.url)) as unknown as Transport)
  expect((await tool('trivia_blueprint_patch', { ops: [listPage()], label: 'Draft' })).isError).not.toBe(true)

  const result = await tool('trivia_blueprint_preview', { page: 'Customers' })
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toMatchObject({
    page: 'Customers', route: '/__blueprint/Customers', module: expect.stringContaining('/@trivia/preview/'),
    next: expect.stringContaining('Open the Trivia designer'),
  })
  expect(result.structuredContent).not.toHaveProperty('code')
  const withCode = await tool('trivia_blueprint_preview', { page: 'Customers', includeCode: true })
  expect(withCode.structuredContent).toMatchObject({ code: expect.stringContaining('export function CustomerList()') })
})
