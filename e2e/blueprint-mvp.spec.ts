import { expect, test, type APIRequestContext, type Response } from '@playwright/test'

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
