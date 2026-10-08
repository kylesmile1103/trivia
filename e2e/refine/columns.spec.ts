// Slice 1 of docs/product.md, end to end: on a Refine + shadcn list page, the Data tab shows the
// page's columns and the contract fields it doesn't show yet. Adding one writes a typed column
// into the page source, the canvas renders it, and undo restores the file byte for byte.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type FrameLocator, type Page, expect, test } from '@playwright/test'

const LIST = fileURLToPath(new URL('../../examples/refine-admin/src/pages/customers/list.tsx', import.meta.url))
const original = fs.readFileSync(LIST, 'utf8')

test.afterEach(() => {
  if (fs.readFileSync(LIST, 'utf8') !== original) fs.writeFileSync(LIST, original)
})

const app = (page: Page): FrameLocator => page.frameLocator('iframe[title="App canvas"]')
const headers = (page: Page) => app(page).getByRole('columnheader')
const columns = (page: Page) => page.getByRole('list', { name: 'Columns of CustomerList' }).getByRole('listitem')
const undo = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true })

async function open(page: Page) {
  await page.goto('/__trivia/')
  await expect(app(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible()
  await page.getByRole('tab', { name: 'Data' }).click()
  await expect(columns(page)).toHaveCount(5)
}

test('the Data tab lists the page\'s columns and adds a contract field as a typed column', async ({ page }) => {
  await open(page)
  await expect(columns(page)).toHaveText([/^Name/, /^Email/, /^Status/, /^Customer since/, /^actions/])
  await expect(page.getByRole('region', { name: 'This page' })).toContainText('Customer')

  await page.getByRole('button', { name: 'Add column' }).click()
  await page.getByRole('menuitem', { name: /kycStatus/ }).click()

  // The canvas renders it: a header with its multi-select filter, and badge cells.
  // Before the row actions, not after them.
  await expect(headers(page)).toHaveText(['Name', 'Email', 'Status', 'Customer since', 'KYC status', ''])
  await expect(app(page).getByRole('row').nth(1).getByText('approved')).toBeVisible()
  await expect(columns(page)).toHaveCount(6)
  const code = fs.readFileSync(LIST, 'utf8')
  expect(code).toContain('<DataTableFilterCombobox')
  expect(code).toContain('{ label: "Not started", value: "not_started" },')
  expect(code.startsWith(original.slice(0, original.indexOf('import { Badge }')))).toBe(true)

  await undo(page).click()
  await expect(headers(page)).toHaveText(['Name', 'Email', 'Status', 'Customer since', ''])
  await expect.poll(() => fs.readFileSync(LIST, 'utf8')).toBe(original)
})

test('columns move and go away from the panel, each one undo entry', async ({ page }) => {
  await open(page)
  const status = columns(page).filter({ hasText: /^Status/ })
  await status.hover()
  await status.getByRole('button', { name: 'Move Status up' }).click()
  await expect(headers(page)).toHaveText(['Name', 'Status', 'Email', 'Customer since', ''])

  const email = columns(page).filter({ hasText: /^Email/ })
  await email.hover()
  await email.getByRole('button', { name: 'Remove column Email' }).click()
  await expect(headers(page)).toHaveText(['Name', 'Status', 'Customer since', ''])
  await expect(columns(page)).toHaveCount(4)

  await undo(page).click()
  await expect(headers(page)).toHaveText(['Name', 'Status', 'Email', 'Customer since', ''])
  await undo(page).click()
  await expect(headers(page)).toHaveText(['Name', 'Email', 'Status', 'Customer since', ''])
  await expect.poll(() => fs.readFileSync(LIST, 'utf8')).toBe(original)
})
