import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type Locator, type Page, expect, test } from '@playwright/test'

import { restoreAll } from '../files'

const SERVER = fileURLToPath(new URL('../../examples/next-admin/app/page.tsx', import.meta.url))
const CLIENT = fileURLToPath(new URL('../../examples/next-admin/src/components/edit-demo.tsx', import.meta.url))
const originals = new Map([SERVER, CLIENT].map((file) => [file, fs.readFileSync(file, 'utf8')]))
const read = (file: string) => fs.readFileSync(file, 'utf8')
const frame = (page: Page) => page.frameLocator('iframe[title="App canvas"]')
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' })
const historyAction = (page: Page, label: 'Undo' | 'Redo') => page.getByRole('button', { name: label, exact: true })
const selected = (page: Page) => page.evaluate(() =>
  (window as Window & { __trivia?: { state(): { selected: string | null } } }).__trivia?.state().selected,
)
/** What the Undo control names (its tooltip): the designer's history, as the designer last read it. */
const undoLabel = (page: Page) => page.evaluate(() =>
  (window as Window & { __trivia?: { state(): { history: { undoLabel: string | null } } } }).__trivia?.state().history.undoLabel,
)

test.afterEach(async () => {
  await restoreAll(originals)
})

async function clickCanvas(page: Page, target: Locator, button: 'left' | 'right' = 'left') {
  await expect(target).toBeVisible()
  await expect(page.getByTestId('canvas-overlay')).not.toHaveAttribute('aria-busy')
  const box = await target.boundingBox()
  if (!box) throw new Error('missing canvas bounds')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button })
}

async function apply(page: Page, op: Record<string, unknown>) {
  const response = await page.request.post('/@trivia/api/apply', { data: { op } })
  await expect(response).toBeOK()
  return (await response.json()).data as { locator: string; changed: boolean }
}

test('FR-TN-05 selects a Next client component, inspects its props, and updates a variant in place', async ({ page }) => {
  await page.goto('/__trivia/')
  const button = frame(page).getByRole('button', { name: 'Count 0' })
  const locator = 'src/components/edit-demo.tsx#EditDemo#0.1'
  await expect(button).toHaveAttribute('data-ast-node', locator)
  await expect(button).toHaveAttribute('data-variant', 'default')
  await clickCanvas(page, button)
  await expect.poll(() => selected(page)).toBe(locator)
  await expect(inspector(page).getByRole('heading', { name: 'Button', exact: true })).toBeVisible()
  const variant = inspector(page).getByRole('combobox', { name: 'variant', exact: true })
  await expect(variant).toHaveText('default')
  await button.evaluate((el) => { el.ownerDocument.documentElement.dataset.testDocument = 'client-edit' })

  await variant.click()
  await page.getByRole('option', { name: 'outline', exact: true }).click()
  const source = originals.get(CLIENT)!
  await expect.poll(() => read(CLIENT)).toBe(source.replace('setCount(count + 1)}>', 'setCount(count + 1)} variant="outline">'))
  await expect(button).toHaveAttribute('data-variant', 'outline')
  expect(await button.evaluate((el) => el.ownerDocument.documentElement.dataset.testDocument)).toBe('client-edit')
  await expect.poll(() => selected(page)).toBe(locator)
})

test('FR-TN-05 changes just the text in a server component, then undoes it byte for byte', async ({ page }) => {
  await page.goto('/__trivia/')
  const original = frame(page).getByRole('heading', { name: 'Next.js back office' })
  const locator = 'app/page.tsx#Home#0.0'
  await expect(original).toHaveAttribute('data-ast-node', locator)
  await clickCanvas(page, original)
  await expect(inspector(page).getByRole('region', { name: 'Text' })).toContainText('Next.js back office')
  await original.evaluate((el) => { el.ownerDocument.documentElement.dataset.testDocument = 'server-edit' })

  await apply(page, { op: 'setText', target: locator, expectedName: 'h1', text: 'Server heading edited' })
  const changed = frame(page).getByRole('heading', { name: 'Server heading edited' })
  await expect(changed).toHaveAttribute('data-ast-node', locator)
  expect(await changed.evaluate((el) => el.ownerDocument.documentElement.dataset.testDocument)).toBe('server-edit')
  expect(read(SERVER)).toBe(originals.get(SERVER)!.replace('Next.js back office', 'Server heading edited'))
  await historyAction(page, 'Undo').click()
  await expect(original).toBeVisible()
  await expect.poll(() => read(SERVER)).toBe(originals.get(SERVER)!)
})

test('FR-TN-05 inserts, moves, removes, undoes and redoes guarded Next edits', async ({ page }) => {
  await page.goto('/__trivia/')
  const note = frame(page).locator('#demo-note')
  const target = 'src/components/edit-demo.tsx#EditDemo#0.2'
  await expect(note).toHaveAttribute('data-ast-node', target)
  const result = await apply(page, { op: 'insert', target, expectedName: 'p', placement: 'before', snippet: '<p id="added-note">Added note</p>' })
  expect(result.changed).toBe(true)
  const added = frame(page).locator('#added-note')
  await expect(added).toHaveAttribute('data-ast-node', result.locator)
  const notes = frame(page).locator('#edit-demo > p')
  await expect(notes).toHaveText(['Added note', 'Client component'])

  const inserted = read(CLIENT)
  const refused = await page.request.post('/@trivia/api/apply', {
    data: { op: { op: 'remove', target: result.locator, expectedName: 'Button' } },
  })
  expect(refused.status()).toBe(409)
  expect(await refused.json()).toMatchObject({ ok: false, error: { code: 'stale_locator' } })
  expect(read(CLIENT)).toBe(inserted)

  await expect(historyAction(page, 'Undo')).toBeEnabled()
  // The designer reads history by polling: until it has seen the insert, the canvas still
  // expects to go busy for it, and refuses a right-click then. The run before ends on another label.
  await expect.poll(() => undoLabel(page)).toBe('Insert element')
  await clickCanvas(page, added, 'right')
  await page.getByRole('menu', { name: 'Actions for p' }).getByRole('menuitem', { name: 'Move down' }).click()
  await expect(notes).toHaveText(['Client component', 'Added note'])
  const moved = read(CLIENT)
  await clickCanvas(page, added)
  await expect.poll(() => selected(page)).toBe('src/components/edit-demo.tsx#EditDemo#0.3')
  await page.keyboard.press('Delete')
  await expect(added).toHaveCount(0)
  await expect.poll(() => read(CLIENT)).toBe(originals.get(CLIENT)!)

  await historyAction(page, 'Undo').click()
  await expect(notes).toHaveText(['Client component', 'Added note'])
  await expect.poll(() => read(CLIENT)).toBe(moved)
  await historyAction(page, 'Redo').click()
  await expect(added).toHaveCount(0)
  await expect.poll(() => read(CLIENT)).toBe(originals.get(CLIENT)!)
})

// Next.js 16.4.6 can leave a page on its old render after an edit written while it loaded: an
// HMR update that reaches it before its React root first commits is lost, and one written before
// its HMR socket subscribed never arrives. Once a canvas document has hydrated, the canvas
// reloads it if the dev service wrote since it began to load, and refreshes the app's router
// otherwise (LLD-13 §6), which renders what is on disk.

type RouterRequests = Window & { routerRequests?: Array<{ path: string; hydrated: boolean }> }

test('FR-TN-05 refreshes a Next canvas document once after it hydrates, then lets the user in', async ({ page }) => {
  // The App Router asks for a fresh server render with `?_rsc=`. Note each such request, and
  // whether Next's route announcer (added in an effect after the root's first commit) was there.
  // The canvas iframe's first document is about:blank, whose window the app's document reuses:
  // this runs there, and its fetch wrapper stays.
  await page.addInitScript(() => {
    const w = window as RouterRequests
    if (location.pathname.startsWith('/__trivia') || w.routerRequests) return
    w.routerRequests = []
    const fetch = w.fetch
    w.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (url.searchParams.has('_rsc')) w.routerRequests!.push({ path: url.pathname, hydrated: document.querySelector('next-route-announcer') !== null })
      return fetch.call(this, input, init)
    } as typeof fetch
  })
  // With no write while the document loads, it is never reloaded: one document request.
  let documents = 0
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() !== page.mainFrame()) documents++
  })
  await page.goto('/__trivia/')
  const app = frame(page)
  const requests = () => app.locator(':root').evaluate(() => (window as RouterRequests).routerRequests)
  await expect.poll(requests).toEqual([{ path: '/', hydrated: true }])
  await expect(page.getByTestId('canvas-overlay')).not.toHaveAttribute('aria-busy')
  await page.waitForTimeout(500) // nothing else asks for one: no edit, no navigation
  expect(await requests()).toHaveLength(1)
  expect(documents).toBe(1)
})

test('FR-TN-05 shows an edit written while the Next canvas loads, every time', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/__trivia/')
  const app = frame(page)
  const target = 'src/components/edit-demo.tsx#EditDemo#0.2'
  await expect(app.locator('#demo-note')).toHaveAttribute('data-ast-node', target)
  for (let round = 1; round <= 15; round++) {
    // Reload the canvas's document, and edit (over the API, as an agent would) the moment its
    // server-rendered HTML shows the node: before React has hydrated it.
    await app.locator(':root').evaluate((root, n) => {
      root.setAttribute('data-round', String(n))
      setTimeout(() => location.reload())
    }, round)
    await expect(app.locator(`:root:not([data-round="${round}"]) #demo-note`)).toHaveAttribute('data-ast-node', target)
    const result = await apply(page, { op: 'insert', target, expectedName: 'p', placement: 'before', snippet: '<p id="added-note">Added note</p>' })
    expect(result.changed).toBe(true)
    await expect(app.locator('#added-note'), `round ${round}`).toHaveAttribute('data-ast-node', result.locator)
    await restoreAll(originals)
    await expect(app.locator('#added-note'), `round ${round}, restored`).toHaveCount(0)
  }
})

test('FR-TN-05 a click on a Next canvas that is still loading selects once it has caught up', async ({ page }) => {
  await page.goto('/__trivia/')
  // The server's HTML is on the canvas before the app has hydrated: click it without waiting.
  const box = await frame(page).getByRole('heading', { name: 'Next.js back office' }).boundingBox()
  if (!box) throw new Error('missing canvas bounds')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect.poll(() => selected(page)).toBe('app/page.tsx#Home#0.0')
  await expect(inspector(page).getByRole('region', { name: 'Text' })).toContainText('Next.js back office')
})
