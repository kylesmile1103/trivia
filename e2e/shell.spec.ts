// The designer shell against the real stack: playground dev server (with the plugin and the
// native engine) behind the designer's proxy. These tests edit playground files on disk and
// write the originals back after each test.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { type Locator, type Page, expect, test } from '@playwright/test'

const playground = path.resolve(import.meta.dirname, '../examples/playground')
const DASHBOARD = path.join(playground, 'src/pages/Dashboard.tsx')
const WATCHED = [DASHBOARD, path.join(playground, 'src/App.tsx')]
const appPort = Number(process.env.TRIVIA_APP_PORT ?? 5173)

/** The playground components the prop analyzer reports, by palette group. */
const GROUPS = {
  Form: ['Button', 'Input', 'Textarea', 'Label', 'Field', 'Checkbox', 'Switch', 'Select'],
  Layout: ['Card', 'Separator'],
  Display: ['Badge', 'Table'],
}

let originals: Map<string, Buffer>

test.beforeEach(async () => {
  originals = new Map(await Promise.all(WATCHED.map(async (f) => [f, await readFile(f)] as const)))
})

test.afterEach(async () => {
  for (const [file, bytes] of originals) {
    if (!(await readFile(file)).equals(bytes)) await writeFile(file, bytes)
  }
})

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
interface NodeDetails {
  locator: string
  name: string
  text: string | null
  children: string[]
}
interface HistoryState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}
interface Template {
  component: string
  label: string
  snippet: string
  imports: { name: string; source: string }[]
}

/** Call the engine API from the page, as the designer (and an agent in the page) would. */
async function api<T>(page: Page, endpoint: string, body?: unknown): Promise<T> {
  const envelope = await page.evaluate(
    async ({ endpoint, body }) => {
      const init: RequestInit =
        body === undefined
          ? {}
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      const res = await fetch(`/@trivia/api${endpoint}`, init)
      return res.json()
    },
    { endpoint, body },
  )
  const result = envelope as Envelope<T>
  if (!result.ok) throw new Error(`${endpoint}: ${result.error.code}: ${result.error.message}`)
  return result.data
}

const inspect = (page: Page, locator: string) => api<NodeDetails>(page, `/inspect?locator=${encodeURIComponent(locator)}`)

/** Breadth-first through the Dashboard's JSX for the first node matching `test`. */
async function findNode(page: Page, match: (n: NodeDetails) => boolean): Promise<NodeDetails> {
  const queue = ['src/pages/Dashboard.tsx#Dashboard#0']
  while (queue.length > 0) {
    const node = await inspect(page, queue.shift() as string)
    if (match(node)) return node
    queue.push(...node.children)
  }
  throw new Error('node not found in Dashboard.tsx')
}

const setVariant = (page: Page, target: string, value: string) =>
  api(page, '/apply', { op: { op: 'updateProp', target, expectedName: 'Button', prop: 'variant', value }, label: 'Set variant' })

const dashboard = () => readFile(DASHBOARD)

async function open(page: Page) {
  await page.goto('/__trivia/')
  await expect(page.getByRole('banner')).toContainText('Trivia')
}

/** Component names of the palette rows under `scope`, in order. */
const itemNames = (scope: Locator) =>
  scope.locator('[data-palette-item]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-palette-item')))

const undoButton = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true })
const redoButton = (page: Page) => page.getByRole('button', { name: 'Redo', exact: true })
const palette = (page: Page) => page.getByRole('complementary', { name: 'Components' })

test('boots into the shell: target, grouped palette, history as the engine reports it', async ({ page }) => {
  await open(page)
  await expect(page.getByRole('button', { name: `Connected to localhost:${appPort}. Reload` })).toBeVisible()

  const list = palette(page)
  for (const [group, names] of Object.entries(GROUPS)) {
    const section = list.getByRole('region', { name: group })
    await expect(section).toBeVisible()
    await expect.poll(() => itemNames(section)).toEqual(names)
  }

  // Fresh dev server: nothing to undo or redo. (When other suites ran first, the buttons
  // must still mirror the engine's history exactly.)
  const history = await api<HistoryState>(page, '/history')
  await expect(undoButton(page)).toBeEnabled({ enabled: history.canUndo })
  await expect(redoButton(page)).toBeEnabled({ enabled: history.canRedo })
  if (!history.canUndo && !history.canRedo) {
    await expect(undoButton(page)).toBeDisabled()
    await expect(redoButton(page)).toBeDisabled()
  }
})

test('search narrows the palette to matching components and parts', async ({ page }) => {
  await open(page)
  const list = palette(page)
  await page.keyboard.press('/')
  await expect(page.getByRole('searchbox', { name: 'Search components' })).toBeFocused()
  await page.keyboard.type('title')
  await expect.poll(() => itemNames(list)).toEqual(['Field', 'FieldTitle', 'Card', 'CardTitle'])
  await page.keyboard.press('Escape')
  await expect(list.locator('[data-palette-item="Select"]')).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search components' }).fill('zzz')
  await expect(list).toContainText('No components match “zzz”.')
})

test('dragging a palette item carries its template', async ({ page }) => {
  await open(page)
  // A stand-in drop target (the canvas overlay is the real one) that records what arrives.
  await page.evaluate(() => {
    const zone = document.createElement('div')
    zone.id = 'shell-test-drop'
    zone.style.cssText = 'position:fixed;left:50%;top:50%;width:200px;height:200px;z-index:9999;'
    zone.addEventListener('dragover', (e) => e.preventDefault())
    zone.addEventListener('drop', (e) => {
      e.preventDefault()
      const t = e.dataTransfer
      zone.dataset['received'] = JSON.stringify({
        effect: t?.effectAllowed,
        template: t?.getData('application/x-trivia-template'),
        text: t?.getData('text/plain'),
      })
    })
    document.body.append(zone)
  })
  await palette(page).locator('[data-palette-item="Card"]').dragTo(page.locator('#shell-test-drop'))
  const received = await page.locator('#shell-test-drop').getAttribute('data-received')
  const payload = JSON.parse(received ?? 'null') as { effect: string; template: string; text: string }
  const template = JSON.parse(payload.template) as Template
  expect(payload.effect).toBe('copy')
  expect(template.component).toBe('Card')
  expect(template.snippet).toContain('<CardDescription>Description</CardDescription>')
  expect(template.imports.map((i) => i.name)).toEqual(['Card', 'CardHeader', 'CardTitle', 'CardDescription', 'CardContent'])
  expect(payload.text).toBe(template.snippet)
})

test('every palette template inserts through the engine, indented, and undoes byte-for-byte', async ({ page }) => {
  await open(page)
  const original = await dashboard()
  const content = await findNode(page, (n) => n.name === 'CardContent')
  // CardContent's children sit one level (two spaces) deeper than its own line.
  const childIndent = ' '.repeat(10)

  const names = Object.values(GROUPS).flat()
  for (const name of names) {
    const transfer = await page.evaluateHandle(() => new DataTransfer())
    await palette(page).locator(`[data-palette-item="${name}"]`).dispatchEvent('dragstart', { dataTransfer: transfer })
    const template = await transfer.evaluate((t) => JSON.parse(t.getData('application/x-trivia-template')) as Template)

    const result = await api<{ changed: boolean; locator: string }>(page, '/apply', {
      op: { op: 'insert', target: content.locator, placement: 'lastChild', snippet: template.snippet, imports: template.imports },
      label: `Insert ${name}`,
    })
    expect(result.changed, name).toBe(true)
    const edited = (await dashboard()).toString('utf8')
    const block = template.snippet
      .split('\n')
      .map((line) => childIndent + line)
      .join('\n')
    expect(edited, `${name} is inserted with its nesting re-indented`).toContain(block)
    for (const spec of template.imports) {
      expect(edited, `${name} imports ${spec.name}`).toMatch(new RegExp(`import \\{[^}]*\\b${spec.name}\\b[^}]*\\} from "${spec.source}"`))
    }
    expect((await inspect(page, result.locator)).name).toBe(name)

    await api(page, '/undo', {})
    expect((await dashboard()).equals(original), `undo after inserting ${name}`).toBe(true)
  }
})

test('the undo button restores Dashboard.tsx byte-identically', async ({ page }) => {
  await open(page)
  const original = await dashboard()
  const save = await findNode(page, (n) => n.name === 'Button' && n.text === 'Save changes')

  await setVariant(page, save.locator, 'outline')
  expect((await dashboard()).equals(original)).toBe(false)

  // The edit came from outside the designer's action bus; the shell picks it up.
  await expect(undoButton(page)).toBeEnabled()
  await undoButton(page).hover()
  await expect(page.getByRole('tooltip')).toContainText('Undo “Set variant”')

  await undoButton(page).click()
  await expect.poll(async () => (await dashboard()).equals(original)).toBe(true)
  await expect(redoButton(page)).toBeEnabled()
})

test('⌘Z / ⇧⌘Z work in the designer and inside the canvas iframe; text fields keep their own undo', async ({ page }) => {
  await open(page)
  const original = await dashboard()
  const save = await findNode(page, (n) => n.name === 'Button' && n.text === 'Save changes')

  await setVariant(page, save.locator, 'secondary')
  const edited = await dashboard()
  expect(edited.equals(original)).toBe(false)

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await dashboard()).equals(original)).toBe(true)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(async () => (await dashboard()).equals(edited)).toBe(true)

  // A same-origin frame of the app, like the canvas: its key events never reach the designer
  // window, so the shell listens on the frame's window too.
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.id = 'shell-test-frame'
    frame.src = '/'
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:640px;height:480px;'
    document.body.append(frame)
  })
  const app = page.frameLocator('#shell-test-frame')

  // Typing in the app's input: ⌘Z is the input's own undo, not a source edit.
  await app.locator('input#name').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await page.waitForTimeout(1000)
  expect((await dashboard()).equals(edited), 'undo must not fire from a text field').toBe(true)

  await app.getByRole('button', { name: 'Save changes' }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await dashboard()).equals(original)).toBe(true)
})

test('zoom: buttons, menu and shortcuts, clamped to 25–200%', async ({ page }) => {
  await open(page)
  const level = page.getByRole('button', { name: 'Zoom level' })
  await expect(level).toHaveText('100%')
  await page.keyboard.press('ControlOrMeta+=')
  await expect(level).toHaveText('125%')
  await page.keyboard.press('ControlOrMeta+-')
  await page.keyboard.press('ControlOrMeta+-')
  await expect(level).toHaveText('75%')
  await page.keyboard.press('ControlOrMeta+0')
  await expect(level).toHaveText('100%')

  await level.click()
  await page.getByRole('menuitemradio', { name: '200%' }).click()
  await expect(level).toHaveText('200%')
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeDisabled()
  await page.getByRole('button', { name: 'Zoom out' }).click()
  await expect(level).toHaveText('175%')
  // Fit is the canvas's call (100% for a frame that fills its area); either way it leaves 175%.
  await page.keyboard.press('Shift+Digit1')
  await expect(level).not.toHaveText('175%')
})

test('an unreachable engine gets a full-screen explanation, and retry connects', async ({ page }) => {
  // Hold the automatic retry, so the Retry button is what reconnects.
  await page.clock.install()
  // What Vite's proxy answers (502, empty body) when the user's dev server refuses the connection.
  await page.route('**/@trivia/api/health', (route) => route.fulfill({ status: 502, body: '' }))
  await page.goto('/__trivia/')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText("Can't reach the Trivia engine")
  await expect(alert).toContainText(`nothing answered at http://localhost:${appPort}`)
  await expect(alert).toContainText(`/@trivia/api/health → HTTP 502`)
  await expect(alert).toContainText('vite-plugin-ast-locator')
  await expect(alert).toContainText('TRIVIA_TARGET')

  await page.unroute('**/@trivia/api/health')
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(palette(page).locator('[data-palette-item="Button"]')).toBeVisible()
})

test('losing the engine mid-session flags the toolbar, and it recovers on its own', async ({ page }) => {
  await open(page)
  await expect(palette(page).locator('[data-palette-item="Button"]')).toBeVisible()
  await page.route('**/@trivia/api/{history,health}', (route) => route.fulfill({ status: 502, body: '' }))
  await expect(page.getByRole('button', { name: `Disconnected from localhost:${appPort}. Reconnect` })).toBeVisible()
  await expect(page.getByText('Lost the connection to the engine')).toBeVisible()

  await page.unroute('**/@trivia/api/{history,health}')
  await expect(page.getByRole('button', { name: `Connected to localhost:${appPort}. Reload` })).toBeVisible()
  await expect(page.getByText('Reconnected to the engine')).toBeVisible()
})

test('zoom to fit shows the whole page without scrolling, and never zooms past 100%', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 300 }) // too short for the Dashboard
  await open(page)
  const level = page.getByRole('button', { name: 'Zoom level' })
  const overflow = () =>
    page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="App canvas"]')!
      const doc = frame.contentDocument!
      return doc.documentElement.scrollHeight - doc.defaultView!.innerHeight
    })
  await expect.poll(overflow).toBeGreaterThan(0)
  await page.keyboard.press('Shift+Digit1')
  await expect(level).not.toHaveText('100%')
  const percent = Number((await level.textContent())!.replace('%', ''))
  expect(percent).toBeGreaterThanOrEqual(25)
  expect(percent).toBeLessThan(100)
  await expect.poll(overflow).toBeLessThanOrEqual(0)

  // A page that already fits is shown at 100%, not blown up.
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.keyboard.press('ControlOrMeta+=')
  await page.keyboard.press('Shift+Digit1')
  await expect(level).toHaveText('100%')
})

test('the layers tab shows the canvas as a tree: rows select, the canvas selection marks its row', async ({ page }) => {
  await open(page)
  await page.getByRole('tab', { name: 'Layers' }).click()
  const tree = page.getByRole('tree', { name: 'Layers' })
  const cancel = tree.getByRole('treeitem', { name: 'Button Cancel' })
  await expect(cancel).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'CardFooter' })).toBeVisible()
  // The badges come from plans.map(): one layer, three elements.
  await expect(tree.getByRole('treeitem', { name: 'Badge Hobby ×3' })).toBeVisible()

  await cancel.click()
  await expect(cancel).toHaveAttribute('aria-selected', 'true')
  const cancelLocator = await page.frameLocator('iframe[title="App canvas"]').getByRole('button', { name: 'Cancel' }).getAttribute('data-ast-node')
  await expect(cancel).toHaveAttribute('data-layer', cancelLocator!)

  // Selecting on the canvas marks the row.
  const save = page.frameLocator('iframe[title="App canvas"]').getByRole('button', { name: 'Save changes' })
  const b = (await save.boundingBox())!
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
  await expect(tree.getByRole('treeitem', { name: 'Button Save changes' })).toHaveAttribute('aria-selected', 'true')

  // `/` brings the component search back from the Layers tab.
  await page.getByTestId('canvas-overlay').focus()
  await page.keyboard.press('/')
  await expect(page.getByRole('searchbox', { name: 'Search components' })).toBeFocused()
})
