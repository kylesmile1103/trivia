import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type Locator, type Page, expect, test } from '@playwright/test'

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

test.afterEach(() => {
  for (const [file, original] of originals) if (read(file) !== original) fs.writeFileSync(file, original)
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
