// Slice 4 of docs/product.md, end to end: a contract resource's missing pages, from the Data tab.
// They are written, registered in <Refine resources> and routed; the app serves them at once;
// undo deletes them and restores App.tsx byte for byte.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { type FrameLocator, type Page, expect, test } from '@playwright/test'

const ROOT = fileURLToPath(new URL('../../examples/refine-admin/', import.meta.url))
const APP = path.join(ROOT, 'src/App.tsx')
const ACCOUNTS = path.join(ROOT, 'src/pages/accounts')
const original = fs.readFileSync(APP, 'utf8')
const NEW = ['create', 'edit', 'show'].map((k) => path.join(ACCOUNTS, `${k}.tsx`))

test.afterEach(() => {
  if (fs.readFileSync(APP, 'utf8') !== original) fs.writeFileSync(APP, original)
  for (const file of NEW) fs.rmSync(file, { force: true })
})

const app = (page: Page): FrameLocator => page.frameLocator('iframe[title="App canvas"]')

test('the Data tab adds a resource\'s missing pages, and the app serves them', async ({ page }) => {
  await page.goto('/__trivia/')
  await expect(app(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible()
  await page.getByRole('tab', { name: 'Data' }).click()
  const account = page.getByRole('listitem', { name: 'Account' })
  await expect(account.getByLabel('Account pages')).toHaveText('ListCreateEditShow')
  await account.getByRole('button', { name: 'Add create, edit, show pages' }).click()

  await expect.poll(() => NEW.every((f) => fs.existsSync(f))).toBe(true)
  await expect(account.getByRole('button', { name: /^Add .* pages?$/ })).toHaveCount(0)
  // The new create page renders in the canvas, with the create body's fields.
  await page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe[title="App canvas"]')!.contentWindow!.location.assign('/accounts/create'))
  await expect(app(page).locator('[data-slot="field-label"]')).toHaveText(['Customer ID', 'Type', 'Currency', 'Overdraft limit'])

  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(() => fs.readFileSync(APP, 'utf8')).toBe(original)
  await expect.poll(() => NEW.some((f) => fs.existsSync(f))).toBe(false)
})
