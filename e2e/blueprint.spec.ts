import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test, type Page } from '@playwright/test'

const root = fileURLToPath(new URL('../examples/refine-admin/', import.meta.url))
const name = 'CanvasDraft'
const doc = `pages/${name}.page.json`
const route = '/draft-canvas'
const text = 'A page from the blueprint'

async function post<T>(page: Page, endpoint: string, data: unknown): Promise<T> {
  const response = await page.request.post('/@trivia/api' + endpoint, { data })
  const body = await response.json()
  expect(response.ok(), JSON.stringify(body)).toBe(true)
  return body.data as T
}

async function navigateCanvas(page: Page, route: string) {
  await page.locator('iframe[title="App canvas"]').evaluate((frame, url) =>
    (frame as HTMLIFrameElement).contentWindow!.location.assign(url), route)
}

test('SC-004 previews a draft, ejects it, and edits the ejected source from the inspector', async ({ page }) => {
  const app = path.join(root, 'src/App.tsx')
  const blueprint = path.join(root, 'blueprint')
  const lock = path.join(blueprint, 'blueprint.lock.json')
  const source = path.join(root, `src/pages/${name}/${name}.tsx`)
  const before = fs.readFileSync(app)
  const priorLock = fs.existsSync(lock) ? fs.readFileSync(lock) : null
  expect(fs.existsSync(source)).toBe(false)
  expect(fs.existsSync(path.join(blueprint, doc))).toBe(false)
  const dirs = [path.dirname(source), path.join(blueprint, 'pages'), blueprint].filter((dir) => !fs.existsSync(dir))
  const canvas = page.frameLocator('iframe[title="App canvas"]')
  try {
    await page.goto('/__trivia/')
    await expect(canvas.getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible({ timeout: 30_000 })
    const initial = await post<{ revs: Record<string, string>; created: Record<string, string> }>(page, '/blueprint/patch', {
      label: 'Draft a page', ops: [{ op: 'createPage', doc, baseRev: null, name, route, kind: 'custom' }],
    })
    const first = await post<{ revs: Record<string, string> }>(page, '/blueprint/patch', { label: 'Set draft content', ops: [
      { op: 'setProp', doc, baseRev: initial.revs[doc], node: initial.created[name + '/page'], expectedType: 'div', prop: 'children', value: 'First draft' },
      { op: 'setStyle', doc, baseRev: initial.revs[doc], node: initial.created[name + '/page'], expectedType: 'div', className: 'grid grid-cols-2' },
    ] })
    const firstPreview = await post<{ route: string }>(page, '/blueprint/preview', { page: name })
    await navigateCanvas(page, firstPreview.route)
    await expect(canvas.getByText('First draft', { exact: true })).toBeVisible({ timeout: 30_000 })
    await post(page, '/blueprint/patch', { label: 'Revise the draft', ops: [
      { op: 'setProp', doc, baseRev: first.revs[doc], node: initial.created[name + '/page'], expectedType: 'div', prop: 'children', value: text },
    ] })
    const preview = await post<{ route: string; code: string }>(page, '/blueprint/preview', { page: name })
    await navigateCanvas(page, preview.route)
    const element = canvas.getByText(text, { exact: true })
    await expect(element).toBeVisible({ timeout: 30_000 })
    await expect(element).toHaveCSS('display', 'grid')
    expect(fs.existsSync(source)).toBe(false)
    expect(fs.readFileSync(app)).toEqual(before)

    const { ops, label } = await post<{ ops: unknown[]; label: string }>(page, '/blueprint/plan', { pages: [name] })
    await post(page, '/batch', { ops, label })
    await post(page, '/blueprint/ejected', { pages: [name], entry: label })
    expect(fs.readFileSync(source, 'utf8')).toBe(preview.code)
    const ejected = [app, lock, source].map((file) => fs.readFileSync(file))
    await navigateCanvas(page, route)
    await expect(element).toHaveAttribute('data-ast-node', new RegExp(`^src/pages/${name}/${name}\\.tsx#`), { timeout: 30_000 })
    const box = (await element.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const inspector = page.getByRole('complementary', { name: 'Inspector' })
    await expect(inspector.getByRole('heading', { name: 'div', exact: true })).toBeVisible()
    await inspector.getByRole('button', { name: 'Add prop' }).click()
    await inspector.getByRole('textbox', { name: 'Prop name' }).fill('title')
    const value = inspector.getByRole('textbox', { name: 'Prop value' })
    await value.fill('Edited in the inspector')
    await value.press('Enter')
    await expect(element).toHaveAttribute('title', 'Edited in the inspector', { timeout: 15_000 })
    expect(fs.readFileSync(source, 'utf8')).toContain('title="Edited in the inspector"')

    const undo = page.getByRole('button', { name: 'Undo', exact: true })
    await undo.click()
    await expect.poll(() => fs.readFileSync(source, 'utf8')).toBe(preview.code)
    await undo.click()
    await expect.poll(() => fs.existsSync(source)).toBe(false)
    expect(fs.readFileSync(app)).toEqual(before)
    expect(fs.existsSync(lock) ? fs.readFileSync(lock) : null).toEqual(priorLock)
    await page.getByRole('button', { name: 'Redo', exact: true }).click()
    await expect.poll(() => fs.existsSync(source)).toBe(true)
    expect([app, lock, source].map((file) => fs.readFileSync(file))).toEqual(ejected)
    await undo.click()
    await expect.poll(() => fs.existsSync(source)).toBe(false)
  } finally {
    if (!fs.readFileSync(app).equals(before)) fs.writeFileSync(app, before)
    if (priorLock) fs.writeFileSync(lock, priorLock)
    else fs.rmSync(lock, { force: true })
    fs.rmSync(source, { force: true })
    fs.rmSync(path.join(blueprint, doc), { force: true })
    for (const dir of dirs) if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir)
  }
})
