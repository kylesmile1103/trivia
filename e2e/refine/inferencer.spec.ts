// Slice 6 of docs/product.md, end to end: refine-admin renders Transactions' show route with
// `<OpenApiShowInferencer />`. The page comes from the contract and runs live, before any file
// exists. Eject writes it and puts it in the route, as one undo entry.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { type FrameLocator, type Page, expect, test } from '@playwright/test'

const ROOT = fileURLToPath(new URL('../../examples/refine-admin/', import.meta.url))
const APP = path.join(ROOT, 'src/App.tsx')
const SHOW = path.join(ROOT, 'src/pages/transactions/show.tsx')
const original = fs.readFileSync(APP, 'utf8')

test.afterEach(() => {
  if (fs.readFileSync(APP, 'utf8') !== original) fs.writeFileSync(APP, original)
  fs.rmSync(SHOW, { force: true })
})

const app = (page: Page): FrameLocator => page.frameLocator('iframe[title="App canvas"]')
const banner = (page: Page) => app(page).getByRole('region', { name: 'Trivia inferencer' })

test('the inferencer runs the contract\'s page live, and Eject writes it into the route', async ({ page }) => {
  await page.goto('/__trivia/')
  await expect(app(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible()
  await page.evaluate(() =>
    document.querySelector<HTMLIFrameElement>('iframe[title="App canvas"]')!.contentWindow!.location.assign('/transactions/show/00000000-0000-4000-8000-000300000001'),
  )
  // The generated page, rendering the real record through the app's data provider.
  await expect(banner(page)).toContainText('Inferred from the OpenAPI contract: Transaction details page')
  await expect(app(page).getByText('Acme Ltd')).toBeVisible()
  expect(fs.existsSync(SHOW)).toBe(false)
  // Styled as the file will be: the preview brings the Tailwind classes no file on disk has yet.
  await expect.poll(() => app(page).locator('dl').evaluate((dl) => getComputedStyle(dl).gridTemplateColumns.split(' ').length)).toBe(2)

  // Clicks reach the app in Interact mode.
  await page.getByRole('radio', { name: 'Interact' }).click()
  await banner(page).getByRole('button', { name: 'View code' }).click()
  await expect(app(page).getByRole('dialog', { name: 'Generated code for src/pages/transactions/show.tsx' })).toContainText('export function TransactionShow()')
  await app(page).getByRole('button', { name: 'Close' }).click()

  await banner(page).getByRole('button', { name: 'Eject to disk' }).click()
  await expect(banner(page).getByRole('textbox', { name: 'File to write' })).toHaveValue('src/pages/transactions/show.tsx')
  await banner(page).getByRole('button', { name: 'Write the file' }).click()

  // The route now renders the file: same page, no banner.
  await expect.poll(() => fs.existsSync(SHOW)).toBe(true)
  await expect.poll(() => fs.readFileSync(APP, 'utf8')).toContain('<Route path="/transactions/show/:id" element={<TransactionShow />} />')
  expect(fs.readFileSync(APP, 'utf8')).not.toContain('@trivia/openapi-inferencer')
  await expect(banner(page)).toHaveCount(0, { timeout: 15_000 })
  await expect(app(page).getByText('Acme Ltd')).toBeVisible()

  // One undo entry takes it all back.
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(() => fs.readFileSync(APP, 'utf8')).toBe(original)
  await expect.poll(() => fs.existsSync(SHOW)).toBe(false)
  await expect(banner(page)).toBeVisible({ timeout: 15_000 })
})
