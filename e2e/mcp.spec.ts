// Point and ask, end to end (docs/mcp.md): the user selects on the real canvas, an agent's MCP
// client (here: the official SDK, as Claude Code would) reads that selection and edits through
// the user's dev server, and the designer shows the edit and keeps the selection on its element.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type FrameLocator, type Page, expect, test } from '@playwright/test'

const DASHBOARD_FILE = fileURLToPath(new URL('../examples/playground/src/pages/Dashboard.tsx', import.meta.url))
const original = fs.readFileSync(DASHBOARD_FILE, 'utf8')
const DASHBOARD = 'src/pages/Dashboard.tsx'
const SAVE = `${DASHBOARD}#Dashboard#0.0.2.1`
const APP = `http://localhost:${process.env.TRIVIA_APP_PORT ?? 5173}`

let agent: Client | null = null

test.afterEach(async () => {
  await agent?.close()
  agent = null
  if (fs.readFileSync(DASHBOARD_FILE, 'utf8') !== original) fs.writeFileSync(DASHBOARD_FILE, original)
})

const app = (page: Page): FrameLocator => page.frameLocator('iframe[title="App canvas"]')
const selected = (page: Page) =>
  page.evaluate(async () => {
    const { designer } = await import('/__trivia/src/shared/state/store.ts' as string)
    return designer.getState().selected as string | null
  })

async function connectAgent(): Promise<Client> {
  const client = new Client({ name: 'e2e-agent', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${APP}/@trivia/mcp`)) as never)
  agent = client
  return client
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const r = (await agent!.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: any }
  if (r.isError) throw new Error(`${name} failed: ${r.content.map((c) => c.text).join('\n')}`)
  return r.structuredContent
}

test('an agent edits what the user selected, and the selection follows its element', async ({ page }) => {
  await page.goto('/__trivia/')
  const save = app(page).getByRole('button', { name: 'Save changes' })
  await expect(save).toBeVisible()
  const b = (await save.boundingBox())!
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
  await expect.poll(() => selected(page)).toBe(SAVE)
  // The designer tells the plugin once the inspector has named the element.
  await expect
    .poll(async () => (await (await fetch(`${APP}/@trivia/api/selection`)).json()).data.selection)
    .toEqual({ locator: SAVE, name: 'Button' })

  await connectAgent()
  const { selection } = await tool('trivia_get_selection')
  expect(selection).toMatchObject({ locator: SAVE, name: 'Button', text: 'Save changes' })
  expect(selection.component.props.find((p: { name: string }) => p.name === 'variant').options).toContain('outline')

  // "Put a New badge before this."
  const inserted = await tool('trivia_apply', {
    label: 'Add a New badge',
    ops: [
      {
        op: 'insert',
        target: selection.locator,
        expectedName: selection.name,
        placement: 'before',
        snippet: '<Badge>New</Badge>',
        imports: [{ name: 'Badge', source: '@/components/ui/badge' }],
      },
    ],
  })
  expect(inserted.history.undoLabel).toBe('Agent: Add a New badge')
  await expect(app(page).getByText('New', { exact: true })).toBeVisible()
  // The Save button moved one place along; so did the selection, in the plugin and the designer.
  const moved = `${DASHBOARD}#Dashboard#0.0.2.2`
  expect(inserted.selection.selection).toEqual({ locator: moved, name: 'Button' })
  await expect.poll(() => selected(page), { timeout: 10_000 }).toBe(moved)
  // The designer's undo button picks the agent's entry up from the shared history (its 2 s sync).
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled({ timeout: 10_000 })

  // "Now call it Save now." The agent asks again: "this" is still the button.
  const again = (await tool('trivia_get_selection')).selection
  expect(again).toMatchObject({ locator: moved, name: 'Button' })
  await tool('trivia_apply', { label: 'Rename save', ops: [{ op: 'setText', target: again.locator, expectedName: 'Button', text: 'Save now' }] })
  await expect(app(page).getByRole('button', { name: 'Save now' })).toBeVisible()
  await expect.poll(() => selected(page)).toBe(moved)

  // Both edits are in the designer's undo history; the agent undoes its own, newest first.
  await tool('trivia_undo', { label: 'Agent: Rename save' })
  await tool('trivia_undo', { label: 'Agent: Add a New badge' })
  expect(fs.readFileSync(DASHBOARD_FILE, 'utf8')).toBe(original)
  await expect(app(page).getByRole('button', { name: 'Save changes' })).toBeVisible()
})
