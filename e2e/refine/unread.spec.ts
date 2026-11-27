// A Refine page Trivia cannot read says why (docs/api.md, refine/unread): the customers list,
// rewritten to pass useTable its options through a variable, still renders, and the Data tab
// names the hook, the line and the reason where it showed the columns.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type FrameLocator, type Page, expect, test } from '@playwright/test'

import { restore, writeWhole } from '../files'

const LIST = fileURLToPath(new URL('../../examples/refine-admin/src/pages/customers/list.tsx', import.meta.url))
const original = fs.readFileSync(LIST, 'utf8')

test.afterEach(async () => {
  await restore(LIST, original)
})

const app = (page: Page): FrameLocator => page.frameLocator('iframe[title="App canvas"]')

test('a list page whose useTable options Trivia cannot read says why in the Data tab', async ({ page }) => {
  const call = '  const table = useTable<CustomerDto>({\n    columns,\n    refineCoreProps: {\n      resource: "customers",\n    },\n  });\n'
  expect(original).toContain(call)
  const rewritten = original.replace(call, '  const options = { columns, refineCoreProps: { resource: "customers" } };\n  const table = useTable<CustomerDto>(options);\n')
  await writeWhole(LIST, rewritten)
  const line = rewritten.split('\n').findIndex((l) => l.includes('useTable<CustomerDto>(options)')) + 1

  await page.goto('/__trivia/')
  await expect(app(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible()
  await page.getByRole('tab', { name: 'Data' }).click()
  const card = page.getByLabel('CustomerList is not read')
  await expect(card).toContainText(`src/pages/customers/list.tsx:${line}`)
  await expect(card).toContainText("Trivia can't edit this list's columns: useTable's options are `options`, not an object literal written in the call")
  await expect(page.getByRole('list', { name: 'Columns of CustomerList' })).toHaveCount(0)
})
