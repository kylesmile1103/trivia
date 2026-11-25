import { readFileSync } from 'node:fs'
import path from 'node:path'

import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test'

test.beforeEach(({}, info) => {
  const missing = info.project.metadata.missingMvp
  test.skip(Boolean(missing), missing)
})

const customers = '/api/v1/customers'
const active = { fullName: 'Active Customer', email: 'active@example.test', status: 'active', creditLimit: 75 }
const pending = { fullName: 'Pending Customer', email: 'pending@example.test', status: 'pending' }

async function seed(request: APIRequestContext, data: typeof active | typeof pending): Promise<string> {
  const response = await request.post(customers, { data })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()).id
}

const customerResponse = (response: Response, method: string) =>
  new URL(response.url()).pathname === customers && response.request().method() === method

test('FR-MVP-01, FR-MVP-02: the generated app lists, filters, refetches, creates and displays API field errors', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await seed(request, active)
  await seed(request, pending)
  await page.goto('/customers')
  await expect(page.getByRole('cell', { name: active.fullName })).toBeVisible()
  await expect(page.getByRole('cell', { name: pending.fullName })).toBeVisible()

  await page.getByRole('button', { name: 'Filter by status' }).click()
  await page.getByRole('combobox', { name: 'Choose status values' }).click()
  await page.getByRole('option', { name: 'Active', exact: true }).click()
  await page.keyboard.press('Escape')
  const filter = page.waitForResponse((response) =>
    customerResponse(response, 'GET') && new URL(response.url()).searchParams.get('filter') === 'status:in:active')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  expect((await filter).status()).toBe(200)
  await expect(page.getByRole('cell', { name: pending.fullName })).toHaveCount(0)
  await expect(page.getByRole('cell', { name: active.fullName })).toBeVisible()

  const refresh = page.waitForResponse((response) =>
    customerResponse(response, 'GET') && new URL(response.url()).searchParams.get('filter') === 'status:in:active')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  expect((await refresh).status()).toBe(200)

  await page.getByRole('link', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/\/customers\/create$/)
  await page.getByRole('textbox', { name: 'Full name' }).fill('Browser Customer')
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('browser@example.test')
  const submit = page.getByRole('button', { name: 'Create customer', exact: true })

  // Bypass the mirrored client constraint once and let the real API reject the request.
  await page.route('**' + customers, (route) => route.continue({
    postData: { ...route.request().postDataJSON(), fullName: 'X' },
  }), { times: 1 })
  const validation = page.waitForResponse((response) => customerResponse(response, 'POST'))
  await submit.click()
  const invalid = await validation
  expect(invalid.status()).toBe(400)
  const problem = await invalid.json()
  expect(problem.errors.fullName).toEqual([expect.any(String)])
  await expect(page.getByRole('textbox', { name: 'Full name' })).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText(problem.errors.fullName[0], { exact: true })).toBeVisible()

  await page.getByRole('textbox', { name: 'Full name' }).fill('Saved Browser Customer')
  const created = page.waitForResponse((response) => customerResponse(response, 'POST'))
  await submit.click()
  expect((await created).status()).toBe(201)
  await expect(page).toHaveURL(/\/customers$/)
  await expect(page.getByRole('cell', { name: 'Saved Browser Customer' })).toBeVisible()
  expect(errors).toEqual([])
})

test('FR-MVP-02: confirming Approve KYC shows the real 501 as a notification', async ({ page, request }) => {
  const fullName = 'KYC Customer'
  const id = await seed(request, { fullName, email: 'kyc@example.test', status: 'pending' })
  await page.goto('/customers')
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: fullName, exact: true }) })
  await expect(row).toBeVisible()
  const approve = row.getByRole('button', { name: 'Approve KYC' })
  const operation = page.waitForResponse((response) =>
    new URL(response.url()).pathname === customers + '/' + id + '/approve-kyc' && response.request().method() === 'POST')
  let confirmMessage: string | undefined
  page.once('dialog', async (dialog) => {
    confirmMessage = dialog.message()
    await dialog.accept()
  })
  await approve.click()
  expect(confirmMessage).toBe('Approve KYC for this customer?')
  expect((await operation).status()).toBe(501)
  await expect(page.getByText('Custom operation is not implemented.', { exact: true })).toBeVisible()
  await expect(row).toBeVisible()
})


const listFile = 'src/pages/customers/list.tsx'
const editFile = 'src/pages/customers/edit.tsx'
const showHeader = 'src/components/refine-ui/views/show-view.tsx'
const canvasSelector = 'iframe[title="App canvas"]'
const canvas = (page: Page) => page.frameLocator(canvasSelector)
const undo = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true })

async function devRoot(request: APIRequestContext): Promise<string> {
  const response = await request.get('/@trivia/api/health')
  expect(response.ok()).toBe(true)
  return (await response.json()).data.root
}

async function navigateCanvas(page: Page, route: string) {
  await page.locator(canvasSelector).evaluate((element, target) =>
    (element as HTMLIFrameElement).contentWindow!.location.assign(target), route)
}

async function addCreditLimit(page: Page) {
  await page.getByRole('tab', { name: 'Data' }).click()
  await page.getByRole('button', { name: 'Add column' }).click()
  await page.getByRole('menuitem', { name: /creditLimit/ }).click()
  await expect(canvas(page).getByRole('columnheader', { name: 'Credit limit' })).toBeVisible()
}

test('FR-MVP-03: designer edits columns, form fields and a show-page prop with byte-exact undo', async ({ page, request }) => {
  const id = await seed(request, { ...active, fullName: 'Designer Customer', email: 'designer@example.test' })
  const root = await devRoot(request)
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8')
  const historyLabel = async () => {
    const response = await request.get('/@trivia/api/history')
    return (await response.json()).data.undoLabel
  }
  const previous = await historyLabel()
  const list = read(listFile)
  const edit = read(editFile)
  const show = read(showHeader)

  await page.goto('/__trivia/')
  await navigateCanvas(page, '/customers')
  await expect(canvas(page).getByRole('cell', { name: 'Designer Customer', exact: true })).toBeVisible()
  await addCreditLimit(page)
  const withColumn = read(listFile)
  expect(withColumn).toContain('accessorKey: "creditLimit"')
  expect(withColumn
    .replace(/^( {6})\{\n\1  id: "creditLimit",[\s\S]*?^\1\},\n/m, '')
    .replace('DataTableFilterDropdownNumeric, ', '')).toBe(list)
  await expect.poll(historyLabel).toBe('Add column Credit limit')
  await undo(page).click()
  await expect.poll(() => read(listFile)).toBe(list)
  await expect.poll(historyLabel).toBe(previous)

  await navigateCanvas(page, '/customers/edit/' + id)
  await expect(canvas(page).getByRole('textbox', { name: 'Full name' })).toHaveValue('Designer Customer')
  await page.getByRole('button', { name: 'Add field' }).click()
  await page.getByRole('menuitem', { name: /notes/ }).click()
  await expect(canvas(page).getByRole('textbox', { name: 'Notes', exact: true })).toBeVisible()
  const withField = read(editFile)
  expect(withField).toContain('notes: z.string().max(1000, "Enter at most 1000 characters.").nullable().optional(),')
  expect(withField).toContain('notes: undefined,')
  expect(withField).toContain('name="notes"')
  expect(withField
    .replace(/^import \{ Textarea \} from "@\/components\/ui\/textarea";?\n/m, '')
    .replace(/^ +notes: [^\n]+\n/gm, '')
    .replace(/^( +)<Controller\n\1  name="notes"[\s\S]*?^\1\/>\n/m, '')).toBe(edit)
  await expect.poll(historyLabel).toBe('Add field Notes')
  await undo(page).click()
  await expect.poll(() => read(editFile)).toBe(edit)
  await expect.poll(historyLabel).toBe(previous)

  await navigateCanvas(page, '/customers/show/' + id)
  await expect(canvas(page).getByText('Designer Customer', { exact: true })).toBeVisible()
  const back = canvas(page).locator(`button[data-size="icon"][data-ast-node^="${showHeader}#ShowViewHeader#"]`)
  await expect(back).toHaveAttribute('data-variant', 'ghost')
  const box = await back.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await inspector.getByRole('combobox', { name: 'variant', exact: true }).click()
  await page.getByRole('option', { name: 'outline', exact: true }).click()
  await expect(back).toHaveAttribute('data-variant', 'outline')
  await expect.poll(() => read(showHeader)).toBe(show.replace('<Button variant="ghost"', '<Button variant="outline"'))
  await expect.poll(historyLabel).toBe('Set Button.variant')
  await undo(page).click()
  await expect.poll(() => read(showHeader)).toBe(show)
  await expect.poll(historyLabel).toBe(previous)
})

test('FR-RC-08, FR-MVP-03: re-eject refuses a designer-edited page and preserves its bytes', async ({ page, request }) => {
  const root = await devRoot(request)
  const files = [listFile, 'src/App.tsx', 'blueprint/blueprint.lock.json'].map((file) => path.join(root, file))
  const snapshot = () => files.map((file) => readFileSync(file, 'utf8'))
  const plan = () => request.post('/@trivia/api/blueprint/plan', { data: { pages: ['CustomerList'] } })
  const before = snapshot()
  expect((await plan()).status()).toBe(200)

  await page.goto('/__trivia/')
  await navigateCanvas(page, '/customers')
  await expect(canvas(page).getByRole('columnheader', { name: 'Status' })).toBeVisible()
  await addCreditLimit(page)

  const edited = snapshot()
  expect(edited[0]).toContain('accessorKey: "creditLimit"')
  expect(edited.slice(1)).toEqual(before.slice(1))
  const refused = await plan()
  expect(refused.status()).toBe(409)
  expect(await refused.json()).toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(snapshot()).toEqual(edited)

  await undo(page).click()
  await expect.poll(snapshot).toEqual(before)
  expect((await plan()).status()).toBe(200)
})
