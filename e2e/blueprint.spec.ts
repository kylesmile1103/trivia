import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { expect, test, type Page } from '@playwright/test'

import { restore } from './files'

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

/** The file's bytes, or null when it is absent (also when it goes away while being read). */
function readOrNull(file: string): Buffer | null {
  try {
    return fs.readFileSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
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
    // An undo or redo of the eject writes its files one after another, the lock last. Wait for
    // all of them: a check (or this test's cleanup) between two writes sees a half-applied
    // entry, and the rest of the entry then lands after the cleanup.
    const files = () => [app, lock, source].map(readOrNull)
    const restored = [before, priorLock, null]
    await undo.click()
    await expect.poll(files, { timeout: 15_000 }).toEqual(restored)
    await page.getByRole('button', { name: 'Redo', exact: true }).click()
    await expect.poll(files, { timeout: 15_000 }).toEqual(ejected)
    await undo.click()
    await expect.poll(files, { timeout: 15_000 }).toEqual(restored)
  } finally {
    await restore(app, before)
    if (priorLock) await restore(lock, priorLock)
    else fs.rmSync(lock, { force: true })
    fs.rmSync(source, { force: true })
    fs.rmSync(path.join(blueprint, doc), { force: true })
    for (const dir of dirs) if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir)
  }
})

test.describe('Blueprint panel', () => {
  const appRoot = fileURLToPath(new URL('../examples/refine-admin/', import.meta.url))
  const blueprint = path.join(appRoot, 'blueprint')
  const appFile = path.join(appRoot, 'src/App.tsx')
  const generated = path.join(appRoot, 'src/pages/accounts/create.tsx')
  const lock = path.join(blueprint, 'blueprint.lock.json')
  const longName = 'Keyboard' + 'BlueprintPage'.repeat(6)
  const pages = ['AccountIntake', 'SearchDraft', 'ConcurrentDraft', longName]
  const files = [
    appFile, generated, lock, path.join(blueprint, 'app.blueprint.json'), path.join(blueprint, 'model.blueprint.json'),
    ...pages.map((name) => path.join(blueprint, 'pages', `${name}.page.json`)),
  ]

  const read = (file: string): Buffer | null => fs.existsSync(file) ? fs.readFileSync(file) : null
  let baseline: Map<string, Buffer | null>
  let newDirs: string[]

  test.beforeEach(() => {
    baseline = new Map(files.map((file) => [file, read(file)]))
    newDirs = [path.join(blueprint, 'pages'), blueprint].filter((dir) => !fs.existsSync(dir))
  })

  test.afterEach(async () => {
    for (const [file, original] of baseline) {
      if (!original) fs.rmSync(file, { force: true })
      else await restore(file, original)
    }
    for (const dir of newDirs) if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir)
  })

  const canvas = (page: Page) => page.frameLocator('iframe[title="App canvas"]')
  const panel = (page: Page) => page.getByRole('region', { name: 'Blueprint pages' })
  const editor = (page: Page) => page.getByRole('region', { name: 'Page editor' })

  async function openBlueprint(page: Page) {
    await page.goto('/__trivia/')
    await expect(canvas(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible({ timeout: 35_000 })
    await page.getByRole('tab', { name: 'Blueprint' }).click()
    if (baseline.get(path.join(blueprint, 'app.blueprint.json')) === null) {
      const create = panel(page).getByRole('button', { name: 'Create blueprint' })
      await create.click()
    }
    await expect(panel(page).getByRole('button', { name: 'Add page' })).toBeEnabled()
  }

  async function createPage(page: Page, name: string, route: string, kind = 'custom') {
    await panel(page).getByRole('button', { name: 'Add page' }).click()
    await editor(page).getByLabel('Name', { exact: true }).fill(name)
    await editor(page).getByLabel('Route', { exact: true }).fill(route)
    await editor(page).getByLabel('Kind', { exact: true }).selectOption(kind)
    if (kind !== 'custom') await editor(page).getByLabel('Resource', { exact: true }).selectOption('Account')
    await editor(page).getByRole('button', { name: 'Create page' }).click()
    await expect(editor(page).getByRole('heading', { name, exact: true })).toBeVisible()
  }

  test('FR-DS-02 FR-DS-04 FR-DS-07 creates, previews, ejects and undoes an account page', async ({ page }) => {
    await openBlueprint(page)
    await createPage(page, 'AccountIntake', '/blueprint-account-intake', 'create')
    const title = editor(page).getByLabel('Title', { exact: true })
    await title.fill('Blueprint account intake')
    await title.press('Enter')
    await panel(page).getByRole('button', { name: 'Preview AccountIntake' }).click()
    await expect(page.getByText('Preview of a draft page. Eject to edit it on the canvas.')).toBeVisible()
    await expect(canvas(page).getByText('Blueprint account intake', { exact: true })).toBeVisible({ timeout: 35_000 })
    await expect(canvas(page).getByText('Customer ID', { exact: true })).toBeVisible()
    expect(read(generated)).toBeNull()

    await panel(page).getByRole('button', { name: 'Eject AccountIntake' }).click()
    const dialog = page.getByRole('dialog', { name: 'Eject AccountIntake' })
    await expect(dialog.getByText('src/pages/accounts/create.tsx', { exact: true })).toBeVisible()
    await expect(dialog.getByText('src/App.tsx', { exact: true })).toBeVisible()
    await expect(dialog.getByText('blueprint/blueprint.lock.json', { exact: true })).toBeVisible()
    await expect(dialog.getByText('/blueprint-account-intake', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Confirm eject' }).click()
    await expect(panel(page).getByRole('button', { name: 'Eject AccountIntake again' })).toBeVisible()
    await expect(canvas(page).locator('[data-ast-node^="src/pages/accounts/create.tsx#"]').first()).toBeVisible({ timeout: 35_000 })
    await expect(page.getByText('Preview of a draft page. Eject to edit it on the canvas.')).toHaveCount(0)
    expect(read(appFile)?.equals(baseline.get(appFile)!)).toBe(false)
    expect(read(lock)?.toString('utf8')).toContain('AccountIntake')

    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => read(generated)).toBeNull()
    await expect.poll(() => read(appFile)).toEqual(baseline.get(appFile))
    await expect.poll(() => read(lock)).toEqual(baseline.get(lock))
    await expect(panel(page).getByRole('button', { name: 'Preview AccountIntake' })).toBeVisible()
  })

  test('FR-DS-03 FR-DS-09 previews text bound to the value exposed by a manifest input', async ({ page }) => {
    await openBlueprint(page)
    await createPage(page, 'SearchDraft', '/blueprint-search')
    const tree = editor(page).getByRole('region', { name: 'Blueprint nodes' })
    await tree.getByLabel('Component', { exact: true }).selectOption('Input')
    await tree.getByLabel('Node name', { exact: true }).fill('search')
    await tree.getByRole('button', { name: 'Add node' }).click()
    await tree.getByRole('button', { name: 'Select search (Input)' }).click()
    const props = editor(page).getByRole('group', { name: 'Node properties' })
    await expect(props.getByText('ui.search.value', { exact: true })).toBeVisible()
    const placeholder = props.getByLabel('placeholder', { exact: true })
    await placeholder.fill('Search blueprint here')
    await placeholder.press('Enter')
    await tree.getByRole('button', { name: 'Select page (div)' }).click()
    await props.getByLabel('children mode', { exact: true }).selectOption('binding')
    await props.getByLabel('children expression', { exact: true }).fill('ui.search.value')
    await props.getByRole('button', { name: 'Save expression' }).click()

    await panel(page).getByRole('button', { name: 'Preview SearchDraft' }).click()
    await page.getByRole('radio', { name: 'Interact' }).or(page.getByRole('button', { name: 'Interact' })).first().click()
    const input = canvas(page).getByPlaceholder('Search blueprint here')
    await expect(input).toBeVisible({ timeout: 35_000 })
    await input.fill('bound blueprint text')
    await expect(canvas(page).getByText('bound blueprint text', { exact: true })).toBeVisible()

    await expect(input).toHaveAttribute('data-bp-node', /^n_/)
    await page.getByRole('tab', { name: 'Layers' }).click()
    await page.getByRole('radio', { name: 'Design' }).click()
    const box = await input.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await expect(page.getByRole('tab', { name: 'Blueprint' })).toHaveAttribute('aria-selected', 'true')
    await expect(tree.getByRole('button', { name: 'Select search (Input)' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('FR-DS-07 refuses a stale save after a concurrent MCP patch and loads the agent revision', async ({ page }) => {
    await openBlueprint(page)
    await createPage(page, 'ConcurrentDraft', '/blueprint-concurrent')
    const doc = 'pages/ConcurrentDraft.page.json'
    const mcp = '/@trivia/mcp'
    const headers = { accept: 'application/json, text/event-stream', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION }
    const initialize = await page.request.post(mcp, { headers, data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'blueprint-conflict-e2e', version: '0' },
    } } })
    expect(initialize.ok(), await initialize.text()).toBe(true)
    const initialized = await page.request.post(mcp, { headers, data: { jsonrpc: '2.0', method: 'notifications/initialized' } })
    expect(initialized.status()).toBe(202)
    let saves = 0
    await page.route('**/@trivia/api/blueprint/patch', async (intercepted) => {
      saves++
      if (saves === 1) {
        const { ops } = intercepted.request().postDataJSON() as { ops: Array<{ baseRev: string }> }
        const result = await page.request.post(mcp, { headers, data: {
          jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trivia_blueprint_patch', arguments: {
            label: 'Set the concurrent route', ops: [{ op: 'setPageMeta', doc, baseRev: ops[0]!.baseRev, route: '/blueprint-agent' }],
          } },
        } })
        expect(await result.json()).toMatchObject({ result: { structuredContent: { entry: 'Agent: Set the concurrent route' } } })
      }
      await intercepted.continue()
    })

    const route = editor(page).getByLabel('Route', { exact: true })
    await route.fill('/blueprint-designer')
    await route.press('Enter')
    await expect(panel(page).getByRole('alert')).toContainText('Your change was not applied')
    await expect(route).toHaveValue('/blueprint-agent')
    expect(read(path.join(blueprint, doc))?.toString('utf8')).toContain('/blueprint-agent')
    expect(saves).toBe(1)
  })

  test('SC-004 opens, fills and closes the page editor with labelled keyboard controls at 1280px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/__trivia/')
    await expect(canvas(page).getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible({ timeout: 35_000 })
    const dataTab = page.getByRole('tab', { name: 'Data', exact: true })
    await dataTab.focus()
    await dataTab.press('ArrowRight')
    const blueprintTab = page.getByRole('tab', { name: 'Blueprint', exact: true })
    await expect(blueprintTab).toBeFocused()
    await expect(blueprintTab).toHaveAttribute('aria-selected', 'true')
    await expect(blueprintTab).toHaveCSS('visibility', 'visible')

    const initialize = panel(page).getByRole('button', { name: 'Create blueprint' })
    await initialize.focus()
    await initialize.press('Enter')
    const add = panel(page).getByRole('button', { name: 'Add page' })
    await add.focus()
    await add.press('Enter')
    const name = editor(page).getByLabel('Name', { exact: true })
    await expect(name).toBeFocused()
    await name.fill(longName)
    await name.press('Tab')
    const route = editor(page).getByLabel('Route', { exact: true })
    await expect(route).toBeFocused()
    await route.fill('/' + 'long-blueprint-route-'.repeat(6) + 'end')
    await route.press('Enter')
    await expect(editor(page).getByRole('heading', { name: longName, exact: true })).toBeVisible()
    expect(await panel(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    const close = editor(page).getByRole('button', { name: 'Close editor' })
    await close.focus()
    await close.press('Enter')
    await expect(add).toBeFocused()
  })

  test('FR-DS-05 FR-DS-06 edits a model and reviews its real .NET file plan before writing', async ({ page }) => {
    await openBlueprint(page)
    await panel(page).getByRole('button', { name: 'Model', exact: true }).click()
    const model = page.getByRole('region', { name: 'Data model' })
    await model.getByLabel('Namespace', { exact: true }).fill('BlueprintAudit')
    await model.getByRole('button', { name: 'Create model' }).click()

    await model.locator('summary').filter({ hasText: /^Add entity$/ }).click()
    const addEntity = model.getByRole('form', { name: 'Add entity' })
    for (const [name, plural] of [['AuditEntry', 'audit-entries'], ['Auditor', 'auditors']]) {
      await addEntity.getByLabel('Entity name', { exact: true }).fill(name)
      await addEntity.getByLabel('Plural route segment', { exact: true }).fill(plural)
      await addEntity.getByRole('button', { name: 'Add entity' }).click()
      await expect(model.getByRole('region', { name: name + ' entity' })).toBeVisible()
    }
    await model.getByLabel('Entity', { exact: true }).selectOption('AuditEntry')
    const entity = model.getByRole('region', { name: 'AuditEntry entity' })
    const addField = entity.getByRole('form', { name: 'Add field' })
    for (const [name, type] of [
      ['displayName', 'string'], ['amount', 'decimal'], ['approved', 'bool'], ['receivedOn', 'date'], ['externalRef', 'uuid'],
    ]) {
      await addField.getByLabel('New field name', { exact: true }).fill(name)
      await addField.getByLabel('New field type', { exact: true }).selectOption(type)
      await addField.getByRole('button', { name: 'Add field' }).click()
      await expect(entity.getByRole('group', { name: 'Field ' + name, exact: true })).toBeVisible()
    }
    const name = entity.getByRole('group', { name: 'Field displayName' }).getByLabel('Name', { exact: true })
    await name.fill('class')
    await name.press('Enter')
    await expect(entity.getByRole('group', { name: 'Field displayName' })).toContainText('"class" is reserved by C#')
    await name.fill('entryName')
    await name.press('Enter')
    await expect(entity.getByRole('group', { name: 'Field entryName' })).toBeVisible()

    const relation = entity.getByRole('form', { name: 'Add relation' })
    await relation.getByLabel('New relation name', { exact: true }).fill('auditors')
    await relation.getByLabel('New relation kind', { exact: true }).selectOption('hasMany')
    await relation.getByLabel('New relation target', { exact: true }).selectOption('Auditor')
    await relation.getByLabel('New foreign key', { exact: true }).fill('entryId')
    await relation.getByRole('button', { name: 'Add relation' }).click()
    await relation.getByRole('button', { name: 'Apply fix' }).click()
    await expect.poll(() => read(path.join(blueprint, 'model.blueprint.json'))?.toString('utf8')).toContain('"kind": "belongsTo"')

    await panel(page).getByRole('button', { name: 'Generate backend', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Generate backend' })
    const filePlan = dialog.getByRole('table', { name: 'Backend file plan' })
    await expect(filePlan).toBeVisible({ timeout: 35_000 })
    const source = 'src/App.Api/Features/AuditEntry/AuditEntry.g.cs'
    await expect(filePlan.getByRole('row').filter({ hasText: source })).toContainText('create')
    await expect(filePlan.getByRole('row').filter({ hasText: 'App.slnx' })).toContainText('create')
    await expect(dialog.getByRole('button', { name: 'Confirm generation' })).toBeEnabled()
    expect(read(path.join(appRoot, source))).toBeNull()
    expect(read(path.join(appRoot, 'App.slnx'))).toBeNull()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  })
})
