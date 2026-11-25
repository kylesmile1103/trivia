// Point and ask, end to end (docs/mcp.md): the user selects on the real canvas, an agent's MCP
// client (here: the official SDK, as Claude Code would) reads that selection and edits through
// the user's dev server, and the designer shows the edit and keeps the selection on its element.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type FrameLocator, type Page, expect, test } from '@playwright/test'

import { restore } from './files'

const DASHBOARD_FILE = fileURLToPath(new URL('../examples/playground/src/pages/Dashboard.tsx', import.meta.url))
const original = fs.readFileSync(DASHBOARD_FILE, 'utf8')
const DASHBOARD = 'src/pages/Dashboard.tsx'
const SAVE = `${DASHBOARD}#Dashboard#0.0.2.1`
const APP = `http://localhost:${process.env.TRIVIA_APP_PORT ?? 5173}`

let agent: Client | null = null

test.afterEach(async () => {
  await agent?.close()
  agent = null
  restore(DASHBOARD_FILE, original)
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

test('trivia_screenshot returns the canvas as the open designer renders it', async ({ page }) => {
  await page.goto('/__trivia/')
  await expect(page.frameLocator('iframe[title="App canvas"]').getByRole('button', { name: 'Save changes' })).toBeVisible()
  await connectAgent()
  const r = (await agent!.callTool({ name: 'trivia_screenshot', arguments: {} })) as {
    isError?: boolean
    content: Array<{ type: string; data?: string; mimeType?: string; text?: string }>
  }
  expect(r.isError, r.content.map((c) => c.text).join('\n')).toBeFalsy()
  const image = r.content[0]!
  expect(image.type).toBe('image')
  expect(image.mimeType).toBe('image/png')
  // Decode it in the browser: the page's real pixels, not a blank sheet.
  const stats = await page.evaluate(async (data) => {
    const img = new Image()
    img.src = `data:image/png;base64,${data}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const pixels = ctx.getImageData(0, 0, c.width, c.height).data
    const colors = new Set<number>()
    for (let i = 0; i < pixels.length; i += 4 * 97) colors.add((pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!)
    return { width: img.width, height: img.height, colors: colors.size }
  }, image.data!)
  const frameWidth = await page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe[title="App canvas"]')!.contentDocument!.documentElement.clientWidth)
  expect(stats.width).toBe(frameWidth)
  expect(stats.height).toBeGreaterThan(200)
  expect(stats.colors).toBeGreaterThan(5) // text, borders, the dark Save button
  expect(r.content[1]?.text).toBe(`The canvas, ${stats.width}×${stats.height} px.`)
})

// A background tab or a covered window gets no animation frames. The user is usually in their
// terminal talking to the agent, so the screenshot must not wait for one.
async function pauseFrames(page: Page, hidden: boolean) {
  await page.evaluate((hide) => {
    window.requestAnimationFrame = () => 0
    if (hide) Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  }, hidden)
}

test('trivia_screenshot works while the designer gets no animation frames', async ({ page }) => {
  await page.goto('/__trivia/')
  await expect(app(page).getByRole('button', { name: 'Save changes' })).toBeVisible()
  await pauseFrames(page, true)
  await connectAgent()
  const r = (await agent!.callTool({ name: 'trivia_screenshot', arguments: {} })) as {
    isError?: boolean
    content: Array<{ type: string; data?: string; text?: string }>
  }
  expect(r.isError, r.content.map((c) => c.text).join('\n')).toBeFalsy()
  expect(r.content[0]?.type).toBe('image')
  expect(r.content[0]?.data?.length).toBeGreaterThan(1000)
})

test('trivia_screenshot says why when a hidden designer stalls on a <canvas>', async ({ page }) => {
  test.setTimeout(40_000)
  await page.goto('/__trivia/')
  await expect(app(page).getByRole('button', { name: 'Save changes' })).toBeVisible()
  // html-to-image still waits for a frame to clone a <canvas> (a chart, say).
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe[title="App canvas"]')!.contentDocument!
    doc.body.append(Object.assign(doc.createElement('canvas'), { width: 20, height: 20 }))
  })
  await pauseFrames(page, true)
  await connectAgent()
  const r = (await agent!.callTool({ name: 'trivia_screenshot', arguments: {} })) as { isError?: boolean; content: Array<{ text?: string }> }
  expect(r.isError).toBe(true)
  expect(r.content[0]?.text).toContain('the designer is in the background')
  expect(r.content[0]?.text).toContain('bring the designer to the front')
})
