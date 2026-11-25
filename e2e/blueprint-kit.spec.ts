import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test, type APIRequestContext } from '@playwright/test'

import { restoreAll, writeWhole } from './files'

const root = fileURLToPath(new URL('../examples/blueprint-kit/', import.meta.url))
const fixture = new URL('../packages/blueprint-compiler/fixtures/kit/', import.meta.url)
const routes = {
  KitDisplay: { path: '/kit/display', heading: 'Actions and display' },
  KitInputs: { path: '/kit/inputs', heading: 'Inputs' },
  KitContainers: { path: '/kit/containers', heading: 'Containers' },
  KitTable: { path: '/kit/table', heading: 'Customer table' },
  KitForm: { path: '/kit/form', heading: 'New customer' },
  KitVirtualTable: { path: '/kit/virtual-table', heading: 'Virtual customer table' },
}
const pages = Object.keys(routes)
const originals = new Map<string, Buffer | null>()
const newDirectories = new Set<string>()

function remember(file: string): string {
  const absolute = path.join(root, file)
  if (!originals.has(absolute)) originals.set(absolute, fs.existsSync(absolute) ? fs.readFileSync(absolute) : null)
  for (let dir = path.dirname(absolute); dir !== root && !fs.existsSync(dir); dir = path.dirname(dir)) {
    newDirectories.add(dir)
  }
  return absolute
}

async function post<T>(request: APIRequestContext, endpoint: string, data: unknown): Promise<T> {
  const response = await request.post('/@trivia/api' + endpoint, { data })
  const body = await response.json()
  expect(response.ok(), JSON.stringify(body)).toBe(true)
  return body.data as T
}

test.beforeAll(async ({ request }) => {
  for (const file of ['app.blueprint.json', ...pages.map((page) => `pages/${page}.page.json`)]) {
    const target = remember('blueprint/' + file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    await writeWhole(target, fs.readFileSync(new URL(file, fixture)))
  }
  const plan = await post<{ ops: Array<{ file?: string }>; label: string }>(request, '/blueprint/plan', { pages })
  remember('src/App.tsx')
  for (const operation of plan.ops) {
    if (operation.file) remember(operation.file)
  }
  await post(request, '/batch', { ops: plan.ops, label: plan.label })
  await post(request, '/blueprint/ejected', { pages, entry: plan.label })
})

test.afterAll(async () => {
  try {
    await restoreAll([...originals].flatMap(([file, before]) => (before === null ? [] : [[file, before] as const])))
  } finally {
    for (const [file, before] of originals) if (before === null) fs.rmSync(file, { force: true })
    for (const dir of [...newDirectories].sort((a, b) => b.length - a.length)) {
      if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir)
    }
  }
})

test('FR-KT-05 renders a window of 5,000 unpaged rows and follows scrolling', async ({ page }) => {
  const items = Array.from({ length: 5_000 }, (_, index) => ({
    id: String(index + 1), fullName: 'Customer ' + String(index + 1).padStart(4, '0'),
    email: `customer-${index + 1}@example.com`, status: 'active',
  }))
  await page.route('**/api/v1/customers?*', async (route) => {
    const url = new URL(route.request().url())
    expect(url.searchParams.has('page')).toBe(false)
    await route.fulfill({ json: { items, total: items.length } })
  })
  await page.goto('/kit/virtual-table')
  const viewport = page.getByRole('region', { name: 'Customer rows' })
  const table = viewport.getByRole('table')
  const rows = table.locator('tbody tr[data-index]')
  await expect(table).toHaveAttribute('aria-rowcount', '5001', { timeout: 30_000 })
  await expect(table.getByRole('cell', { name: 'Customer 0001' })).toBeVisible()
  expect(await rows.count()).toBeLessThan(30)
  await rows.nth(0).getByRole('checkbox').check()
  await rows.nth(1).getByRole('checkbox').check()
  await expect(page.getByText('Selected rows: 2, first 1', { exact: true })).toBeVisible()
  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(table.getByRole('cell', { name: 'Customer 5000' })).toBeVisible()
  await expect(table.getByRole('cell', { name: 'Customer 0001' })).toHaveCount(0)
  await expect(page.getByText('Selected rows: 2, first 1', { exact: true })).toBeVisible()
  expect(await rows.count()).toBeLessThan(30)
})

test('SC-003 ejects and loads every kit fixture without browser errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  for (const route of Object.values(routes)) {
    const response = await page.goto(route.path)
    expect(response?.ok(), route.path).toBe(true)
    await expect(page.getByRole('heading', { name: route.heading, exact: true })).toBeVisible({ timeout: 30_000 })
    expect(errors, route.path).toEqual([])
  }
})

test('FR-KT-01 keeps input bindings in sync with each exposed control', async ({ page }) => {
  await page.goto(routes.KitInputs.path)
  await page.getByRole('textbox', { name: 'Search', exact: true }).fill('Ada')
  await expect(page.getByText('Search value: Ada', { exact: true })).toBeVisible()

  await page.getByRole('textbox', { name: 'Notes', exact: true }).fill('Reviewed')
  await expect(page.locator('p').filter({ hasText: /^Reviewed$/ }).first()).toBeVisible()

  await page.getByRole('checkbox', { name: 'Confirm', exact: true }).check()
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible()
  await page.getByRole('switch', { name: 'Alerts', exact: true }).click()
  await expect(page.getByText('Alerts on', { exact: true })).toBeVisible()

  await page.getByRole('combobox').click()
  await page.getByRole('option', { name: 'Business', exact: true }).click()
  await expect(page.locator('p').filter({ hasText: /^Business$/ }).first()).toBeVisible()

  await page.getByText('Phone', { exact: true }).click()
  await expect(page.locator('p').filter({ hasText: /^phone$/ }).first()).toBeVisible()

  await page.getByRole('button', { name: 'Customer', exact: true }).click()
  await page.getByPlaceholder('Customer', { exact: true }).fill('Grace')
  await page.getByRole('option', { name: 'Grace', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('p').filter({ hasText: /^Grace$/ }).first()).toBeVisible()

  await page.getByRole('button', { name: 'Pick a date', exact: true }).click()
  await page.locator('[data-slot="calendar"] button[data-day]:enabled').first().click()
  await page.keyboard.press('Escape')
  await expect(page.getByText('Birthday selected', { exact: true })).toBeVisible()
})

test('FR-KT-01 exposes the active tab and the open state of kit overlays', async ({ page }) => {
  await page.goto(routes.KitContainers.path)
  await page.getByRole('tab', { name: 'Details', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: 'Details' })).toContainText('Account details')
  await expect(page.getByText('Active tab: details', { exact: true })).toBeVisible()

  for (const overlay of ['dialog', 'sheet', 'help']) {
    await page.getByRole('button', { name: 'Open ' + overlay, exact: true }).click()
    await expect(page.getByText(overlay + ' open', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText(overlay + ' closed', { exact: true })).toBeVisible()
  }
})

test('FR-KT-02 and FR-KT-04 select, page, sort and filter a server table', async ({ page }) => {
  const query = (url: string) => new URL(url).searchParams
  const list = (url: string) => new URL(url).pathname === '/api/v1/customers'
  const initial = page.waitForRequest((request) => list(request.url()) && query(request.url()).get('pageSize') === '3')
  await page.goto(routes.KitTable.path)
  expect(query((await initial).url()).get('page')).toBe('1')
  const rows = page.getByRole('table').locator('tbody')
  await expect(rows.getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible({ timeout: 30_000 })
  await rows.getByRole('row', { name: /Ada Lovelace/ }).getByRole('radio').check()
  await expect(page.getByText('00000000-0000-4000-8000-000100000001', { exact: true })).toBeVisible()

  const next = page.waitForRequest((request) => list(request.url()) && query(request.url()).get('page') === '2')
  await page.getByRole('button', { name: /next page/i }).click()
  await next
  await expect(rows.getByRole('cell', { name: 'Katherine Johnson' })).toBeVisible()

  const sorted = page.waitForRequest((request) => list(request.url()) && query(request.url()).get('sort') === 'fullName')
  await page.getByRole('button', { name: 'Sort by fullName', exact: true }).click()
  expect(query((await sorted).url()).get('order')).toMatch(/^(asc|desc)$/)
  const filter = page.getByRole('button', { name: 'Filter by status', exact: true })
  await filter.click()
  await page.getByRole('combobox', { name: 'Choose status values' }).click()
  await page.getByRole('option', { name: 'Pending', exact: true }).click()
  await page.keyboard.press('Escape')
  const filtered = page.waitForRequest((request) => list(request.url()) && query(request.url()).get('status') === 'pending')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await filtered
  await expect(rows.getByRole('cell', { name: 'Alan Turing' })).toBeVisible()
  await expect(rows.getByRole('cell', { name: 'Margaret Hamilton' })).toBeVisible()
  await expect(rows.getByRole('cell', { name: 'Ada Lovelace' })).toHaveCount(0)
})

test('FR-KT-03 submits the compiled form through the mock API', async ({ page }) => {
  await page.goto(routes.KitForm.path)
  await page.getByRole('textbox', { name: 'Full name' }).fill('Kit Test Customer')
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('kit@example.test')
  await page.getByRole('textbox', { name: 'Notes', exact: true }).fill('A fixture submission')
  const saved = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/v1/customers')
  await page.getByRole('button', { name: 'Create customer', exact: true }).click()
  const response = await saved
  expect(response.status()).toBe(201)
  expect(response.request().postDataJSON()).toMatchObject({
    fullName: 'Kit Test Customer', email: 'kit@example.test', segment: 'retail', notes: 'A fixture submission',
  })
  await expect(page).toHaveURL(/\/kit\/table$/, { timeout: 15_000 })
})

test('NFR-13 supports keyboard form validation and named table controls', async ({ page }) => {
  await page.goto(routes.KitForm.path)
  const form = page.getByRole('form', { name: 'Create customer' })
  const name = form.getByRole('textbox', { name: 'Full name' })
  const email = form.getByRole('textbox', { name: 'Email', exact: true })
  const segment = form.getByRole('combobox', { name: 'Segment' })
  const notes = form.getByRole('textbox', { name: 'Notes' })
  const submit = form.getByRole('button', { name: 'Create customer' })
  await expect(name).toHaveAttribute('aria-required', 'true')
  await name.focus()
  for (const next of [email, segment, notes, submit]) {
    await page.keyboard.press('Tab')
    await expect(next).toBeFocused()
  }
  await page.keyboard.press('Enter')
  await expect(name).toBeFocused()
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await expect(name).toHaveAccessibleDescription('Enter at least 2 characters.')

  await page.goto(routes.KitTable.path)
  const table = page.getByRole('region', { name: 'Customer table', exact: true })
  const row = table.getByRole('row', { name: /Ada Lovelace/ }).getByRole('radio')
  await row.focus()
  await page.keyboard.press('Space')
  await expect(row).toBeChecked()
  const sorter = table.getByRole('button', { name: 'Sort by fullName', exact: true })
  await sorter.press('Enter')
  await expect(table.getByRole('columnheader', { name: /Full name/ })).toHaveAttribute('aria-sort', /^(ascending|descending)$/)
  const filter = table.getByRole('button', { name: 'Filter by status', exact: true })
  await filter.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Filter status' }).getByRole('combobox', { name: 'Choose status values' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(filter).toBeFocused()
})
