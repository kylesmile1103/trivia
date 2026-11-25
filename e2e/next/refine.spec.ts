import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type Page, expect, test } from '@playwright/test'

const CLIENT_LIST = fileURLToPath(new URL('../../examples/next-admin/src/features/bank/customers/list.tsx', import.meta.url))
const PROVIDER = fileURLToPath(new URL('../../examples/next-admin/src/providers/bank-providers.tsx', import.meta.url))
const CREATE = fileURLToPath(new URL('../../examples/next-admin/app/(bank)/accounts/create/page.tsx', import.meta.url))
const originals = new Map([CLIENT_LIST, PROVIDER].map((file) => [file, fs.readFileSync(file, 'utf8')]))
const app = (page: Page) => page.frameLocator('iframe[title="App canvas"]')

test.afterEach(() => {
  for (const [file, original] of originals) {
    if (fs.readFileSync(file, 'utf8') !== original) fs.writeFileSync(file, original)
  }
  fs.rmSync(CREATE, { force: true })
})

test('FR-TN-04 lists Next route patterns and files, and the Refine columns tool edits a page', async ({ page }) => {
  await page.goto('/__trivia/')
  await page.getByRole('tab', { name: 'Pages' }).click()
  const route = (path: string) => page.locator('[data-route=' + JSON.stringify(path) + ']')
  await expect(route('/help/*')).toContainText('app/help/[...slug]/page.tsx')
  await expect(route('/customers/edit/:id')).toContainText('app/(bank)/customers/edit/[id]/page.tsx')
  await expect(route('/customers')).toContainText('Customers')
  await route('/customers').click()
  // Next's dev server compiles a route on its first visit: a Refine table page can take longer
  // than the default 5 s on a cold CI runner.
  await expect(app(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: 'Data' }).click()
  await expect(page.getByRole('list', { name: 'Columns of CustomerList' }).getByRole('listitem')).toHaveCount(5)
  await page.getByRole('button', { name: 'Add column' }).click()
  await page.getByRole('menuitem', { name: /kycStatus/ }).click()
  await expect(app(page).getByRole('columnheader', { name: 'KYC status' })).toBeVisible()
  expect(fs.readFileSync(CLIENT_LIST, 'utf8')).toContain('accessorKey: "kycStatus"')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(app(page).getByRole('columnheader', { name: 'KYC status' })).toHaveCount(0)
  expect(fs.readFileSync(CLIENT_LIST, 'utf8')).toBe(originals.get(CLIENT_LIST))
})

test('registers a missing Refine page as an App Router file and undoes the same change', async ({ page }) => {
  await page.goto('/__trivia/')
  const plan = await page.request.post('/@trivia/api/refine/pages/plan', { data: { resource: 'Account', pages: ['create'] } })
  await expect(plan).toBeOK()
  const { ops, label } = (await plan.json()).data
  expect(ops.map((op: { op: string }) => op.op)).toEqual(['createFile', 'setProperty'])
  expect(ops[0]).toMatchObject({ file: 'app/(bank)/accounts/create/page.tsx' })
  expect(ops[0].content).toMatch(/^"use client";\n/)
  expect(ops[0].content).toContain('export default function AccountCreate()')

  const result = await page.request.post('/@trivia/api/batch', { data: { ops, label } })
  await expect(result).toBeOK()
  const createPath = '/accounts/create'
  await expect.poll(async () => (await page.request.get(createPath)).status()).toBe(200)
  await page.evaluate((url) => {
    document.querySelector<HTMLIFrameElement>('iframe[title="App canvas"]')!.contentWindow!.location.assign(url)
  }, createPath)
  await expect(app(page).getByRole('button', { name: 'Create account', exact: true })).toBeVisible()
  expect(fs.readFileSync(PROVIDER, 'utf8')).toContain('create: "/accounts/create"')

  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(() => fs.existsSync(CREATE)).toBe(false)
  await expect.poll(async () => (await page.request.get(createPath)).status()).toBe(404)
  expect(fs.readFileSync(PROVIDER, 'utf8')).toBe(originals.get(PROVIDER))
})
