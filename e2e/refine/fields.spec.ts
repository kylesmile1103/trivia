// Slice 2 of docs/product.md, end to end: on a Refine form page, the Data tab shows the form's
// fields and the request-body fields it doesn't have. Adding one writes its zod rule, its
// default and a Controller; the canvas renders the input; undo restores the file byte for byte.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type FrameLocator, type Page, expect, test } from '@playwright/test'

const CREATE = fileURLToPath(new URL('../../examples/refine-admin/src/pages/customers/create.tsx', import.meta.url))
const original = fs.readFileSync(CREATE, 'utf8')

test.afterEach(() => {
  if (fs.readFileSync(CREATE, 'utf8') !== original) fs.writeFileSync(CREATE, original)
})

const app = (page: Page): FrameLocator => page.frameLocator('iframe[title="App canvas"]')
const labels = (page: Page) => app(page).locator('[data-slot="field-label"]')
const fields = (page: Page) => page.getByRole('list', { name: 'Fields of CustomerCreate' }).getByRole('listitem')
const undo = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true })

async function open(page: Page) {
  await page.goto('/__trivia/')
  await expect(app(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible()
  // Navigate the app inside the canvas, as a click on its Create button would in Interact mode.
  await page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe[title="App canvas"]')!.contentWindow!.location.assign('/customers/create'))
  await expect(labels(page)).toHaveText(['Full name', 'Email', 'Segment'])
  await page.getByRole('tab', { name: 'Data' }).click()
  await expect(fields(page)).toHaveCount(3)
}

test('the Data tab lists the form\'s fields and adds a request-body field as rule, default and input', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Add field' }).click()
  await expect(page.getByRole('menuitem')).toHaveText([/^phone/, /^creditLimit/, /^birthDate/])
  await page.getByRole('menuitem', { name: /creditLimit/ }).click()

  await expect(labels(page)).toHaveText(['Full name', 'Email', 'Segment', 'Credit limit'])
  await expect(app(page).locator('#customer-credit-limit')).toHaveAttribute('type', 'number')
  const code = fs.readFileSync(CREATE, 'utf8')
  expect(code).toContain('creditLimit: z.number().optional(),')
  expect(code).toContain('creditLimit: undefined,')

  await undo(page).click()
  await expect(labels(page)).toHaveText(['Full name', 'Email', 'Segment'])
  await expect.poll(() => fs.readFileSync(CREATE, 'utf8')).toBe(original)
})

test('fields move and go away, rule and default with them', async ({ page }) => {
  await open(page)
  const segment = fields(page).filter({ hasText: /^Segment/ })
  await segment.hover()
  await segment.getByRole('button', { name: 'Move Segment up' }).click()
  await expect(labels(page)).toHaveText(['Full name', 'Segment', 'Email'])

  const email = fields(page).filter({ hasText: /^Email/ })
  await email.hover()
  await email.getByRole('button', { name: 'Remove field Email' }).click()
  await expect(labels(page)).toHaveText(['Full name', 'Segment'])
  expect(fs.readFileSync(CREATE, 'utf8')).not.toContain('email')

  await undo(page).click()
  await undo(page).click()
  await expect(labels(page)).toHaveText(['Full name', 'Email', 'Segment'])
  await expect.poll(() => fs.readFileSync(CREATE, 'utf8')).toBe(original)
})
