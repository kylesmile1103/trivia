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
