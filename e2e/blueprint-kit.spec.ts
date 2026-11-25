import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test, type APIRequestContext } from '@playwright/test'

const root = fileURLToPath(new URL('../examples/blueprint-kit/', import.meta.url))
const fixture = new URL('../packages/blueprint-compiler/fixtures/kit/', import.meta.url)
const pages = ['KitVirtualTable']
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
    fs.copyFileSync(new URL(file, fixture), target)
  }
  const plan = await post<{ ops: Array<{ file?: string }>; label: string }>(request, '/blueprint/plan', { pages })
  remember('src/App.tsx')
  for (const operation of plan.ops) {
    if (operation.file) remember(operation.file)
  }
  await post(request, '/batch', { ops: plan.ops, label: plan.label })
  await post(request, '/blueprint/ejected', { pages, entry: plan.label })
})

test.afterAll(() => {
  for (const [file, before] of originals) {
    if (before === null) fs.rmSync(file, { force: true })
    else if (!fs.existsSync(file) || !fs.readFileSync(file).equals(before)) fs.writeFileSync(file, before)
  }
  for (const dir of [...newDirectories].sort((a, b) => b.length - a.length)) {
    if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir)
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
  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(table.getByRole('cell', { name: 'Customer 5000' })).toBeVisible()
  await expect(table.getByRole('cell', { name: 'Customer 0001' })).toHaveCount(0)
  expect(await rows.count()).toBeLessThan(30)
})
