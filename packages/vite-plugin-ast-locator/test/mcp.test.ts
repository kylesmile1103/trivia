// The MCP endpoint (docs/mcp.md) through the official SDK client, against a real dev server on
// a copy of the playground: what an agent in Claude Code sees and does.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { copyPlayground, from, get, post, request, socketFetch, startServer, type TestServer } from './helpers.js'

const DASHBOARD = 'src/pages/Dashboard.tsx'
const CANCEL = `${DASHBOARD}#Dashboard#0.0.2.0`
const SAVE = `${DASHBOARD}#Dashboard#0.0.2.1`
const BADGE = { name: 'Badge', source: '@/components/ui/badge' }

let root: string
let server: TestServer
let original: string
const clients: Client[] = []

const read = () => fs.readFileSync(path.join(root, DASHBOARD), 'utf8')

beforeEach(async () => {
  root = copyPlayground()
  server = await startServer(root)
  original = read()
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
})

async function connect(headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'trivia-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/@trivia/mcp'), {
    fetch: socketFetch(server.socket, headers),
  })
  // The SDK's optional properties are typed without exactOptionalPropertyTypes in mind.
  await client.connect(transport as unknown as Transport)
  clients.push(client)
  return client
}

interface ToolResult {
  isError?: boolean
  content: Array<{ type: string; text?: string }>
  structuredContent?: any
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const client = clients[0] ?? (await connect())
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n')
const select = (locator: string | null, name = 'Button') => post(server.socket, '/selection', locator === null ? { locator } : { locator, name })

describe('tools', () => {
  it('are the point-and-ask set', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'trivia_add_pages',
      'trivia_apply',
      'trivia_contract_drift',
      'trivia_edit_columns',
      'trivia_edit_fields',
      'trivia_get_page',
      'trivia_get_selection',
      'trivia_inspect',
      'trivia_list_components',
      'trivia_outline',
      'trivia_screenshot',
      'trivia_sync_openapi',
      'trivia_undo',
    ])
    const apply = tools.find((t) => t.name === 'trivia_apply')!
    expect(apply.description).toContain('expectedName')
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort()).toEqual([
      'trivia_contract_drift',
      'trivia_get_page',
      'trivia_get_selection',
      'trivia_inspect',
      'trivia_list_components',
      'trivia_outline',
      'trivia_screenshot',
    ])
  })
})

describe('trivia_get_selection', () => {
  it('says nothing is selected, and what to ask the user', async () => {
    const r = await call('trivia_get_selection')
    expect(r.isError).toBeFalsy()
    // The hint is in the data too: Claude Code shows the agent structuredContent, not the text.
    expect(r.structuredContent).toMatchObject({ selection: null, hint: expect.stringContaining('Ask the user to select') })
    expect(text(r)).toContain('Ask the user to select')
  })

  it('describes the selected element, and the props its component takes', async () => {
    await select(SAVE)
    const r = await call('trivia_get_selection')
    const s = r.structuredContent.selection
    expect(s).toMatchObject({ locator: SAVE, name: 'Button', file: DASHBOARD, text: 'Save changes', parent: `${DASHBOARD}#Dashboard#0.0.2` })
    expect(s.component).toMatchObject({ name: 'Button', importSource: '@/components/ui/button' })
    const variant = s.component.props.find((p: any) => p.name === 'variant')
    expect(variant).toMatchObject({ kind: 'enum' })
    expect(variant.options).toContain('outline')
  })

  it('refuses a selection the source no longer matches', async () => {
    await select(SAVE, 'Badge')
    const r = await call('trivia_get_selection')
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/^stale_locator: .*<Badge>.*<Button>/s)
    // Reading the selection again won't help: the advice is to ask the user, not to retry.
    expect(text(r)).toContain('Ask the user to select the element again')
    expect(text(r)).not.toContain('call trivia_get_selection')
  })
})

describe('trivia_inspect and trivia_list_components', () => {
  it('describe any element, and the user’s component library', async () => {
    const node = await call('trivia_inspect', { locator: CANCEL })
    expect(node.structuredContent.node).toMatchObject({ locator: CANCEL, name: 'Button', text: 'Cancel' })
    const list = await call('trivia_list_components')
    const names = list.structuredContent.components.map((c: any) => c.name)
    expect(names).toEqual(expect.arrayContaining(['Badge', 'Button', 'Card', 'CardContent', 'Input']))
  })
})

describe('trivia_outline', () => {
  it('gives a file\'s element tree, so an agent can find its way around a page', async () => {
    const r = await call('trivia_outline', { file: DASHBOARD })
    const [root] = r.structuredContent.trees
    expect(root.children[0].children[2].children.map((c: any) => [c.locator, c.text])).toEqual([
      [CANCEL, 'Cancel'],
      [SAVE, 'Save changes'],
    ])
    expect(text(r)).toContain('<Button> Cancel')
  })
})

describe('trivia_apply', () => {
  it('writes the file, lands in the shared undo history, and keeps the selection on its element', async () => {
    await select(SAVE)
    const r = await call('trivia_apply', {
      label: 'Add a badge',
      ops: [{ op: 'insert', target: SAVE, expectedName: 'Button', placement: 'before', snippet: '<Badge>New</Badge>', imports: [BADGE] }],
    })
    expect(r.isError).toBeFalsy()
    expect(read()).toContain('<Badge>New</Badge>\n          <Button>Save changes</Button>')
    expect(r.structuredContent).toMatchObject({
      changed: true,
      locator: `${DASHBOARD}#Dashboard#0.0.2.1`,
      history: { undoLabel: 'Agent: Add a badge' },
      selection: { selection: { locator: `${DASHBOARD}#Dashboard#0.0.2.2`, name: 'Button' }, by: 'agent' },
    })
    expect((await get(server.socket, '/history')).body.data.undoLabel).toBe('Agent: Add a badge')
    expect((await get(server.socket, '/selection')).body.data.selection.locator).toBe(`${DASHBOARD}#Dashboard#0.0.2.2`)
  })

  it('applies several ops as one undo entry', async () => {
    await select(SAVE)
    const r = await call('trivia_apply', {
      label: 'Outline save',
      ops: [
        { op: 'setText', target: SAVE, expectedName: 'Button', text: 'Save' },
        { op: 'updateProp', target: SAVE, expectedName: 'Button', prop: 'variant', value: 'outline' },
      ],
    })
    expect(r.isError).toBeFalsy()
    expect(read()).toContain('<Button variant="outline">Save</Button>')
    expect(r.structuredContent.selection.selection).toEqual({ locator: SAVE, name: 'Button' })
    await post(server.socket, '/undo')
    expect(read()).toBe(original)
  })

  it('clears the selection when it removes the selected element', async () => {
    await select(SAVE)
    await call('trivia_apply', { label: 'Drop save', ops: [{ op: 'remove', target: SAVE, expectedName: 'Button' }] })
    expect((await get(server.socket, '/selection')).body.data).toMatchObject({ selection: null, by: 'agent' })
  })

  it('binds an element to a TanStack Query with bindQuery', async () => {
    const r = await call('trivia_apply', {
      label: 'Bind the badges',
      ops: [
        {
          op: 'bindQuery',
          target: SAVE,
          expectedName: 'Button',
          optionsFn: 'listCustomersOptions',
          optionsImport: '@/api/generated/@tanstack/react-query.gen',
          resource: 'Customer',
          dataProp: 'data',
          loadingProp: 'disabled',
        },
      ],
    })
    expect(r.isError).toBeFalsy()
    expect(read()).toContain('useQuery({ ...listCustomersOptions() })')
    expect(read()).toContain('import { useQuery } from "@tanstack/react-query"')
  })

  it('returns a refusal as a tool error with its code and what to do next', async () => {
    const r = await call('trivia_apply', { label: 'x', ops: [{ op: 'setText', target: SAVE, expectedName: 'Badge', text: 'x' }] })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/^stale_locator: /)
    expect(text(r)).toContain('trivia_get_selection')
    expect(read()).toBe(original)
  })

  it('needs the expected tag names: an op without them writes nothing', async () => {
    const r = await call('trivia_apply', { label: 'x', ops: [{ op: 'remove', target: SAVE }] }).catch((e: Error) => e)
    expect(r instanceof Error ? r.message : text(r)).toMatch(/expectedName/)
    expect(read()).toBe(original)
  })
})

describe('trivia_undo', () => {
  it('undoes only the entry it names', async () => {
    await call('trivia_apply', {
      label: 'Make it outline',
      ops: [{ op: 'updateProp', target: SAVE, expectedName: 'Button', prop: 'variant', value: 'outline' }],
    })
    const edited = read()
    const wrong = await call('trivia_undo', { label: 'Agent: Something else' })
    expect(wrong.isError).toBe(true)
    expect(text(wrong)).toContain('Agent: Make it outline')
    expect(text(wrong)).toContain('tell the user rather than undoing it')
    expect(read()).toBe(edited)
    const r = await call('trivia_undo', { label: 'Agent: Make it outline' })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toMatchObject({ files: [DASHBOARD], history: { canUndo: false, redoLabel: 'Agent: Make it outline' } })
    expect(read()).toBe(original)
  })

  it('works from a fresh session: the selection read says what undo would undo', async () => {
    await call('trivia_apply', {
      label: 'Make it outline',
      ops: [{ op: 'updateProp', target: SAVE, expectedName: 'Button', prop: 'variant', value: 'outline' }],
    })
    const { history } = (await call('trivia_get_selection')).structuredContent
    expect(history).toMatchObject({ canUndo: true, undoLabel: 'Agent: Make it outline' })
    expect((await call('trivia_undo', { label: history.undoLabel })).isError).toBeFalsy()
    expect(read()).toBe(original)
  })
})

describe('who may call it', () => {
  it('refuses other machines and foreign pages, as the API does', async () => {
    await expect(connect(from('192.168.1.66'))).rejects.toThrow(/403|refusing/)
    await expect(connect({ origin: 'http://evil.example' })).rejects.toThrow(/403|refusing/)
  })

  it('takes POST only: a stateless server has no event stream to GET', async () => {
    const r = await request(server.socket, '/@trivia/mcp', { headers: { accept: 'text/event-stream' } })
    expect(r.status).toBe(405)
  })

  it('is not served with api: false', async () => {
    const off = await startServer(root, { api: false })
    try {
      const r = await request(off.socket, '/@trivia/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' } })
      expect(r.status).not.toBe(200)
    } finally {
      await off.close()
    }
  })
})

// A 1×1 PNG, as the designer would post one.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('trivia_screenshot', () => {
  it('returns the PNG the open designer posts for it', async () => {
    const next = get(server.socket, '/screenshot/next') // the designer's long-poll
    const shot = call('trivia_screenshot')
    const { body } = await next
    expect(typeof body.data.id).toBe('string')
    const posted = await post(server.socket, '/screenshot', { id: body.data.id, png: `data:image/png;base64,${PIXEL}`, width: 1, height: 1 })
    expect(posted.status).toBe(200)
    const r = await shot
    expect(r.isError).toBeFalsy()
    expect(r.content[0]).toEqual({ type: 'image', data: PIXEL, mimeType: 'image/png' })
    expect(text(r)).toContain('1×1')
  })

  it('goes to a designer still open, not one that hung up', async () => {
    const closed = new AbortController()
    const gone = request(server.socket, '/@trivia/api/screenshot/next', { signal: closed.signal }).catch(() => null)
    await new Promise((resolve) => setTimeout(resolve, 50))
    closed.abort() // that designer tab was closed mid-poll
    await gone
    await new Promise((resolve) => setTimeout(resolve, 50))
    const next = get(server.socket, '/screenshot/next')
    const shot = call('trivia_screenshot')
    const { body } = await next
    await post(server.socket, '/screenshot', { id: body.data.id, png: PIXEL, width: 1, height: 1 })
    expect((await shot).isError).toBeFalsy()
  })

  it('says so when no designer is open to take it', async () => {
    const quick = await startServer(root, { screenshotTimeoutMs: 200 })
    try {
      const client = new Client({ name: 'trivia-test', version: '0.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/@trivia/mcp'), { fetch: socketFetch(quick.socket) }) as unknown as Transport)
      const r = (await client.callTool({ name: 'trivia_screenshot', arguments: {} })) as ToolResult
      await client.close()
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('no Trivia designer is open')
    } finally {
      await quick.close()
    }
  })
})

describe('trivia_sync_openapi', () => {
  it('regenerates from the manifest\'s spec, so a changed spec is current again', async () => {
    const spec = path.join(root, 'openapi/customers.openapi.json')
    fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('"version": "1.4.0"', '"version": "1.5.0"'))
    expect((await get(server.socket, '/manifest')).body.data.drift.status).toBe('changed')
    const r = await call('trivia_sync_openapi')
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toMatchObject({ source: 'openapi/customers.openapi.json', outputDir: 'src/api/generated', resources: ['Customer', 'Health'] })
    expect(r.structuredContent).toMatchObject({ contractChanged: true })
    expect(r.structuredContent.note).toBeUndefined()
    expect(r.structuredContent.git).toContain('not a git work tree')
    expect((await get(server.socket, '/manifest')).body.data.drift.status).toBe('current')
    expect(fs.existsSync(path.join(root, 'src/api/generated/zod.gen.ts'))).toBe(true) // the manifest had zod
  }, 60_000)

  it('refuses to replace uncommitted changes to the generated code, unless forced', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-qm', 'base')
    const index = path.join(root, 'src/api/generated/index.ts')
    fs.appendFileSync(index, '// hand edit\n')
    const refused = await call('trivia_sync_openapi')
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/^conflict: regenerating would replace uncommitted changes in src\/api\/generated\/index\.ts/)
    expect(text(refused)).toContain('Ask the user to commit those files first')
    expect(text(refused)).not.toContain('changed on disk')
    expect(fs.readFileSync(index, 'utf8')).toContain('// hand edit')
    const forced = await call('trivia_sync_openapi', { force: true })
    expect(forced.isError).toBeFalsy()
    expect(forced.structuredContent.git).toBe('forced: replaced uncommitted changes in src/api/generated/index.ts')
    // The spec itself is as it was: say so, rather than let the agent report an API change.
    expect(forced.structuredContent).toMatchObject({ contractChanged: false, note: expect.stringContaining('has not changed') })
    expect(fs.readFileSync(index, 'utf8')).not.toContain('// hand edit')
  }, 60_000)
})

