// The Data tab end to end: a table bound to the customers list query and a create form, inserted
// into the real playground (contract-sync's generated client, the mock customers API), then used.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type FrameLocator, type Page, expect, test } from '@playwright/test'

import { restore } from './files'

const PLAYGROUND = fileURLToPath(new URL('../examples/playground/', import.meta.url))
const DASHBOARD = `${PLAYGROUND}src/pages/Dashboard.tsx`
const DATA_TABLE = `${PLAYGROUND}src/components/data-table.tsx`
const FORMS = `${PLAYGROUND}src/components/forms`
const original = fs.readFileSync(DASHBOARD, 'utf8')

test.afterEach(async () => {
  await restore(DASHBOARD, original)
  fs.rmSync(DATA_TABLE, { force: true })
  fs.rmSync(FORMS, { recursive: true, force: true })
})

const app = (page: Page): FrameLocator => page.frameLocator('iframe[title="App canvas"]')
const dashboard = () => fs.readFileSync(DASHBOARD, 'utf8')
const settled = (page: Page) => expect(page.getByTestId('canvas-overlay')).not.toHaveAttribute('aria-busy')

async function selectCardContent(page: Page) {
  const content = app(page).locator('[data-slot="card-content"]')
  const box = (await content.boundingBox())!
  // The padding at its top-left corner: CardContent itself, not one of its fields.
  await page.mouse.click(box.x + 4, box.y + 4)
  await expect.poll(() => page.evaluate(async () => {
    const { designer } = await import('/__trivia/src/shared/state/store.ts' as string)
    return designer.getState().details?.name as string | undefined
  })).toBe('CardContent')
}

async function openData(page: Page) {
  await page.goto('/__trivia/')
  await expect(app(page).getByRole('button', { name: 'Save changes' })).toBeVisible()
  await page.getByRole('tab', { name: 'Data' }).click()
  return page.getByRole('listitem', { name: 'Customer' })
}

test('Table inserts a DataTable bound to the list query, showing the API\'s rows; one undo removes it all', async ({ page }) => {
  const customer = await openData(page)
  await selectCardContent(page)
  await customer.getByRole('button', { name: 'Table' }).click()

  await expect(app(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible()
  await expect(app(page).getByRole('columnheader', { name: 'Full name' })).toBeVisible()
  expect(fs.existsSync(DATA_TABLE)).toBe(true)
  const page1 = dashboard()
  expect(page1).toContain('import { useQuery } from "@tanstack/react-query"')
  expect(page1).toContain('useQuery({ ...listCustomersOptions() })')
  expect(page1).toMatch(/<DataTable\n\s+columns=\{\[\n\s+\{ key: "fullName", header: "Full name" \},[\s\S]*data=\{customerData\?\.items \?\? \[\]\}\n\s+isLoading=\{isCustomerLoading\}/)
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled()

  await settled(page)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(dashboard).toBe(original)
  expect(fs.existsSync(DATA_TABLE)).toBe(false)
  await expect(app(page).getByRole('cell', { name: 'Ada Lovelace' })).toHaveCount(0)
})

test('Create form inserts a validated form; submitting it creates a customer that the table then shows', async ({ page }) => {
  const customer = await openData(page)
  await selectCardContent(page)
  await customer.getByRole('button', { name: 'Table' }).click()
  await expect(app(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible()
  await settled(page)
  await selectCardContent(page)
  await customer.getByRole('button', { name: 'Create form' }).click()

  const form = app(page).locator('form')
  await expect(form.getByLabel('Full name *')).toBeVisible()
  expect(fs.existsSync(`${FORMS}/customer-create-form.tsx`)).toBe(true)
  expect(dashboard()).toContain('import { CustomerCreateForm } from "@/components/forms/customer-create-form"')

  // In interact mode the form takes real input; zod refuses a bad email first.
  await page.getByRole('radio', { name: 'Interact' }).or(page.getByRole('button', { name: 'Interact' })).first().click()
  const name = `Test Customer ${Date.now()}`
  await form.getByLabel('Full name *').fill(name)
  await form.getByLabel('Email *').fill('not-an-email')
  await form.getByRole('button', { name: 'Create customer' }).click()
  await expect(form.locator('[data-invalid="true"]')).toHaveCount(1)
  await form.getByLabel('Email *').fill('test@example.com')
  await form.getByRole('button', { name: 'Create customer' }).click()
  await expect(form.getByText('Customer created.')).toBeVisible()
  await expect(app(page).getByRole('cell', { name })).toBeVisible() // the list query was invalidated
})
