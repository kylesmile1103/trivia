// The Pages tab on refine-admin: its routes, read from the source and labelled by <Refine
// resources>; a route loads in the canvas, a route with params asks for them first, and the path
// field opens any path. Nothing here edits the app.

import { type FrameLocator, type Page, expect, test } from '@playwright/test'

const app = (page: Page): FrameLocator => page.frameLocator('iframe[title="App canvas"]')
const ADA = '00000000-0000-4000-8000-000100000001'

test('the Pages tab lists the routes and moves the canvas between pages', async ({ page }) => {
  await page.goto('/__trivia/')
  await expect(app(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible()
  await page.getByRole('tab', { name: 'Pages' }).click()
  const routes = page.getByRole('list', { name: 'Routes' })
  const current = routes.locator('[aria-current="page"]')
  const path = page.getByRole('textbox', { name: 'Path' })

  await expect(routes.locator('[data-route] [data-label]')).toHaveText([
    'NavigateToResource',
    'Customers · List',
    'Customers · Create',
    'Customers · Edit',
    'Accounts · List',
    'Transactions · List',
    'Transactions · Show',
    'ErrorComponent',
  ])
  // The index route redirects to the customers list: that is where the canvas is. The field shows
  // the whole URL: Refine keeps the table's state in the query (syncWithLocation).
  await expect(current).toHaveAttribute('data-route', '/customers')
  await expect(path).toHaveValue(/^\/customers(\?|$)/)

  await routes.locator('[data-route="/accounts"]').click()
  await expect(app(page).getByText('Accounts', { exact: true }).first()).toBeVisible()
  await expect(app(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeHidden()
  await expect(current).toHaveAttribute('data-route', '/accounts')
  await expect(path).toHaveValue(/^\/accounts(\?|$)/)

  // A route with a param asks for it, and opens that record.
  await routes.locator('[data-route="/customers/edit/:id"]').click()
  const id = page.getByRole('textbox', { name: 'id', exact: true })
  await id.fill(ADA)
  await id.press('Enter')
  await expect(app(page).getByLabel('Full name')).toHaveValue('Ada Lovelace')
  await expect(current).toHaveAttribute('data-route', '/customers/edit/:id')
  await expect(path).toHaveValue(new RegExp(`^/customers/edit/${ADA}(\\?|$)`))

  // Any path, typed.
  await path.fill('/customers/create')
  await path.press('Enter')
  await expect(current).toHaveAttribute('data-route', '/customers/create')
  await expect(app(page).getByLabel('Full name')).toHaveValue('')
})
