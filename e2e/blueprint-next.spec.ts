import { expect, test } from '@playwright/test'

const apiPort = Number(process.env.TRIVIA_BLUEPRINT_NEXT_API_PORT ?? 4586)
const customers = 'http://127.0.0.1:' + apiPort + '/api/v1/customers'

test('FR-NX-03 returns the record in HTML, hydrates without a fetch, and returns 404 for a missing record', async ({ request, page }, info) => {
  test.skip(Boolean(info.project.metadata.blueprintNextUnavailable), String(info.project.metadata.blueprintNextUnavailable))
  const fullName = 'Aspire Server Record'
  const created = await request.post(customers, {
    data: { fullName, email: 'next-ssr@example.test', status: 'active', creditLimit: 150 },
  })
  expect(created.status(), await created.text()).toBe(201)
  const { id } = await created.json()
  const url = '/customers/show/' + id

  const html = await request.get(url)
  expect(html.status()).toBe(200)
  expect(await html.text()).toMatch(/<dd[^>]*>Aspire Server Record<\/dd>/)

  const fetches: string[] = []
  page.on('request', (attempt) => {
    const path = new URL(attempt.url()).pathname
    if (path === '/api/v1/customers/' + id) fetches.push(path)
  })
  await page.goto(url)
  await expect(page.getByText(fullName, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Toggle theme/ }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('refine-ui-theme'))).not.toBeNull()
  expect(fetches).toEqual([])

  const missing = await request.get('/customers/show/00000000-0000-0000-0000-000000000001')
  expect(missing.status()).toBe(404)
  expect(await missing.text()).toContain('Page not found')
})

test('FR-NX-04 sends browser API paths through Next to the AppHost API', async ({ request }, info) => {
  test.skip(Boolean(info.project.metadata.blueprintNextUnavailable), String(info.project.metadata.blueprintNextUnavailable))
  const fullName = 'Same Origin Record'
  const created = await request.post('/api/v1/customers', {
    data: { fullName, email: 'next-rewrite@example.test', status: 'active', creditLimit: 200 },
  })
  expect(created.status(), await created.text()).toBe(201)
  const { id } = await created.json()
  const proxied = await request.get('/api/v1/customers/' + id)
  expect(proxied.status()).toBe(200)
  expect(await proxied.json()).toMatchObject({ id, fullName })
  const direct = await request.get(customers + '/' + id)
  expect(await direct.json()).toEqual(await proxied.json())
})

test('FR-NX-02 renders catch-all parameters in a client component on the first response', async ({ request }, info) => {
  test.skip(Boolean(info.project.metadata.blueprintNextUnavailable), String(info.project.metadata.blueprintNextUnavailable))
  const response = await request.get('/probe/north/south')
  expect(response.status()).toBe(200)
  expect(await response.text()).toMatch(/<button[^>]*>north \/ south<\/button>/)
})

test('FR-NX-03 shows the route error UI for an API 500', async ({ page }, info) => {
  test.skip(Boolean(info.project.metadata.blueprintNextUnavailable), String(info.project.metadata.blueprintNextUnavailable))
  const response = await page.goto('/query-probe/00000000-0000-0000-0000-000000000500')
  expect(response?.status()).toBe(500)
  await expect(page.getByRole('heading', { name: 'Could not load this page' })).toBeVisible()
})

test('FR-NX-04 forwards cookie and bearer credentials on the server', async ({ request }, info) => {
  test.skip(Boolean(info.project.metadata.blueprintNextUnavailable), String(info.project.metadata.blueprintNextUnavailable))
  const headers = { cookie: 'trivia-test=present', authorization: 'Bearer e2e-fixture' }
  const response = await request.get('/customers/show/00000000-0000-0000-0000-000000000401', { headers })
  expect(response.status()).toBe(200)
  expect(await response.text()).toMatch(/<dd[^>]*>Credentials forwarded<\/dd>/)
  expect(await (await request.get('/identity-probe', { headers })).text()).toMatch(/<button[^>]*>Fixture user<\/button>/)
  expect(await (await request.get('/identity-probe')).text()).toMatch(/<button[^>]*>Guest<\/button>/)
})
