// Slice 3 of docs/product.md, end to end: the backend's spec changes, the Data tab offers to
// sync, then lists where the pages no longer match the contract, and its fixes rewrite them.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { type FrameLocator, type Page, expect, test } from '@playwright/test'

import { restore, writeWhole } from '../files'

const ROOT = fileURLToPath(new URL('../../examples/refine-admin/', import.meta.url))
const SPEC = path.join(ROOT, 'openapi/bank.openapi.json')
const LIST = path.join(ROOT, 'src/pages/customers/list.tsx')
const CREATE = path.join(ROOT, 'src/pages/customers/create.tsx')

/** Every file the test may change (the spec, what sync regenerates, the pages a fix edits), as it was. */
function snapshot(): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.set(full, fs.readFileSync(full, 'utf8'))
    }
  }
  walk(path.join(ROOT, 'src/api/generated'))
  walk(path.join(ROOT, 'src/pages'))
  for (const file of [SPEC, path.join(ROOT, 'trivia.manifest.json')]) files.set(file, fs.readFileSync(file, 'utf8'))
  return files
}
const before = snapshot()

test.afterEach(async () => {
  for (const [file, text] of before) await restore(file, text)
})

const app = (page: Page): FrameLocator => page.frameLocator('iframe[title="App canvas"]')
const drift = (page: Page) => page.getByRole('region', { name: 'Out of step with the contract' })

test('a spec change: sync, see what it broke, fix it from the Data tab', async ({ page }) => {
  const spec = JSON.parse(before.get(SPEC)!)
  delete spec.components.schemas.CustomerDto.properties.email
  spec.components.schemas.CustomerDto.required = spec.components.schemas.CustomerDto.required.filter((r: string) => r !== 'email')
  spec.components.schemas.CustomerStatus.enum.push('closed')
  // Slice 5: a bound changes, and the forms' rules are edited in place.
  for (const name of ['CustomerDto', 'CreateCustomerRequest', 'UpdateCustomerRequest']) spec.components.schemas[name].properties.fullName.minLength = 3
  await writeWhole(SPEC, JSON.stringify(spec, null, 2))

  await page.goto('/__trivia/')
  await expect(app(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible()
  await page.getByRole('tab', { name: 'Data' }).click()
  await page.getByRole('button', { name: 'Sync', exact: true }).click()

  await expect(drift(page)).toContainText('Out of step with the contract (5)')
  const list = drift(page).getByRole('list', { name: 'Drift in CustomerList' })
  await expect(list.getByRole('listitem')).toHaveText([/Column Email shows `email`/, /Column Status filters on pending, active, suspended; the contract's values are pending, active, suspended, closed/])
  await expect(drift(page).getByRole('list', { name: 'Drift in CustomerEdit' })).toContainText('Field Status offers pending, active, suspended')
  await expect(drift(page).getByRole('list', { name: 'Drift in CustomerCreate' })).toContainText(
    'Field Full name\'s rule has other bounds than the contract: min length 2 → min length 3',
  )

  // The first edit after a sync can wait on a cold transform of the regenerated modules.
  await list.getByRole('button', { name: 'Remove column Email' }).click()
  await expect(app(page).getByRole('columnheader')).toHaveText(['Name', 'Status', 'Customer since', ''], { timeout: 15_000 })
  await drift(page).getByRole('button', { name: 'Rebuild column Status from the contract' }).click()
  await expect(drift(page)).toContainText('Out of step with the contract (3)')
  await expect.poll(() => fs.readFileSync(LIST, 'utf8')).toContain('{ label: "Closed", value: "closed" },')
  await expect(app(page).getByRole('columnheader')).toHaveText(['Name', 'Status', 'Customer since', ''])

  // The bound is edited in the rule, and the message that names it follows.
  const create = drift(page).getByRole('list', { name: 'Drift in CustomerCreate' })
  await create.getByRole('button', { name: 'Update the Full name rule from the contract' }).click()
  await expect(drift(page)).toContainText('Out of step with the contract (2)')
  expect(fs.readFileSync(CREATE, 'utf8')).toContain('fullName: z.string().min(3, "Enter at least 3 characters."),')
})
