import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { expect, test, type Page } from '@playwright/test'

import { restore } from './files'

const DOC = 'pages/BlueprintE2e.page.json'

async function rpc<T>(page: Page, method: string, params?: Record<string, unknown>, notification = false): Promise<T> {
  const message = { jsonrpc: '2.0', ...(!notification && { id: 1 }), method, params }
  const reply = await page.evaluate(async ({ message, protocol }) => {
    const response = await fetch('/@trivia/mcp', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': protocol,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(20_000),
    })
    return { status: response.status, text: await response.text() }
  }, { message, protocol: LATEST_PROTOCOL_VERSION })
  expect(reply.status, reply.text).toBe(notification ? 202 : 200)
  if (notification) return undefined as T
  const envelope = JSON.parse(reply.text) as { error?: { message: string }; result: T }
  if (envelope.error) throw new Error(`${method}: ${envelope.error.message}`)
  return envelope.result
}

async function tool<T>(page: Page, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await rpc<{ isError?: boolean; content: unknown; structuredContent: T }>(page, 'tools/call', { name, arguments: args })
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
  return result.structuredContent
}

for (const { host, folder, url } of [
  { host: 'Vite', folder: 'playground', url: '/__trivia/' },
  { host: 'Next.js', folder: 'next-admin', url: `http://localhost:${process.env.TRIVIA_NEXT_PORT ?? 4402}/__trivia/` },
]) {
  test(`FR-AG-03 browser MCP patch and undo restore blueprint bytes through the ${host} designer proxy`, async ({ page }) => {
    const dir = fileURLToPath(new URL(`../examples/${folder}/blueprint/`, import.meta.url))
    const file = path.join(dir, DOC)
    const existed = fs.existsSync(file)
    const missingDirs = [path.dirname(file), dir].filter((folder) => !fs.existsSync(folder))
    expect(existed, `fixture document already exists: ${file}`).toBe(false)

    try {
      await page.goto(url)
      const initialized = await rpc<{ protocolVersion: string }>(page, 'initialize', {
        protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'browser-mcp-e2e', version: '0' },
      })
      expect(initialized.protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
      await rpc(page, 'notifications/initialized', undefined, true)

      const patch = 'trivia_blueprint_patch'
      const initial = await tool<{ entry: string; revs: Record<string, string> }>(page, patch, {
        label: 'Create browser test page',
        ops: [{ op: 'createPage', doc: DOC, baseRev: null, name: 'BlueprintE2e', route: '/blueprint-e2e', kind: 'custom' }],
      })
      const original = fs.readFileSync(file)
      const edited = await tool<{ entry: string; revs: Record<string, string> }>(page, patch, {
        label: 'Change the browser test page route',
        ops: [{ op: 'setPageMeta', doc: DOC, baseRev: initial.revs[DOC], route: '/blueprint-e2e-edited' }],
      })
      expect(edited.entry).toBe('Agent: Change the browser test page route')
      expect(fs.readFileSync(file, 'utf8')).toContain('/blueprint-e2e-edited')
      const selection = await tool<{ history: { undoLabel: string } }>(page, 'trivia_get_selection', {})
      expect(selection.history.undoLabel).toBe(edited.entry)
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled({ timeout: 15_000 })
      await tool(page, 'trivia_undo', { label: edited.entry })
      expect(fs.readFileSync(file)).toEqual(original)
      const current = await tool<{ rev: string }>(page, 'trivia_blueprint_get', { what: 'doc', path: DOC })
      expect(current.rev).toBe(initial.revs[DOC])
      await tool(page, 'trivia_undo', { label: initial.entry })
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      fs.rmSync(file, { force: true })
      for (const folder of missingDirs) {
        if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder)
      }
    }
  })
}

test('FR-AG-06 previews, screenshots and ejects a draft through the Vite MCP endpoint', async ({ page }) => {
  const root = fileURLToPath(new URL('../examples/refine-admin/', import.meta.url))
  const app = path.join(root, 'src/App.tsx')
  const name = 'McpCanvasDraft'
  const doc = `pages/${name}.page.json`
  const draft = path.join(root, 'blueprint', doc)
  const lock = path.join(root, 'blueprint/blueprint.lock.json')
  const source = path.join(root, `src/pages/${name}/${name}.tsx`)
  const original = fs.readFileSync(app)
  const priorLock = fs.existsSync(lock) ? fs.readFileSync(lock) : null
  expect(fs.existsSync(draft)).toBe(false)
  expect(fs.existsSync(source)).toBe(false)
  const dirs = [path.dirname(source), path.dirname(draft), path.dirname(lock)].filter((dir) => !fs.existsSync(dir))
  try {
    await page.goto(`http://localhost:${process.env.TRIVIA_REFINE_PORT ?? 4401}/__trivia/`)
    const canvas = page.frameLocator('iframe[title="App canvas"]')
    await expect(canvas.getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible({ timeout: 30_000 })
    await rpc(page, 'initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'blueprint-mcp-e2e', version: '0' },
    })
    await rpc(page, 'notifications/initialized', undefined, true)
    const initial = await tool<{ revs: Record<string, string>; created: Record<string, string> }>(page, 'trivia_blueprint_patch', {
      label: 'Create MCP draft', ops: [{ op: 'createPage', doc, baseRev: null, name, route: '/mcp-canvas-draft', kind: 'custom' }],
    })
    await tool(page, 'trivia_blueprint_patch', {
      label: 'Set preview text', ops: [{
        op: 'setProp', doc, baseRev: initial.revs[doc], node: initial.created[name + '/page'], expectedType: 'div', prop: 'children', value: 'MCP preview content',
      }],
    })
    const preview = await tool<{ route: string; code: string }>(page, 'trivia_blueprint_preview', { page: name, includeCode: true })
    await page.locator('iframe[title="App canvas"]').evaluate((frame, url) =>
      (frame as HTMLIFrameElement).contentWindow!.location.assign(url), preview.route)
    await expect(canvas.getByText('MCP preview content')).toBeVisible({ timeout: 30_000 })
    const shot = await rpc<{ isError?: boolean; content: Array<{ type: string; data?: string; mimeType?: string }> }>(page, 'tools/call', {
      name: 'trivia_screenshot', arguments: {},
    })
    expect(shot.isError, JSON.stringify(shot.content)).not.toBe(true)
    expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: expect.stringMatching(/^iVBORw0KGgo/) })
    const ejected = await tool<{ entry: string }>(page, 'trivia_blueprint_eject', { pages: [name], label: 'Eject MCP draft' })
    expect(ejected.entry).toBe('Agent: Eject MCP draft')
    expect(fs.readFileSync(source, 'utf8')).toBe(preview.code)
    await tool(page, 'trivia_undo', { label: ejected.entry })
    expect(fs.readFileSync(app)).toEqual(original)
    expect(fs.existsSync(source)).toBe(false)
    expect(fs.existsSync(lock) ? fs.readFileSync(lock) : null).toEqual(priorLock)
  } finally {
    await restore(app, original)
    if (priorLock) await restore(lock, priorLock)
    else fs.rmSync(lock, { force: true })
    fs.rmSync(source, { force: true })
    fs.rmSync(draft, { force: true })
    for (const dir of dirs) if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir)
  }
})
