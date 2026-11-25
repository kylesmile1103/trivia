import fs from 'node:fs'
import path from 'node:path'

import { apply, loadBlueprint, revOfText, sequenceSource } from '@trivia/blueprint'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { createStandaloneHost, startDevService, type RunningDevService } from '../src/standalone.js'
import { copyBlueprintProject, listPage } from './blueprint-fixture.js'

let root: string
let running: RunningDevService

beforeEach(async () => {
  root = copyBlueprintProject()
  running = await startDevService(createStandaloneHost(root))
})

afterEach(async () => {
  await running?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const get = (suffix = '') => fetch(`${running.url}/@trivia/api/blueprint${suffix}`)
const pagePath = '/doc?path=pages%2FCustomers.page.json'

function writeBlueprint(file: string, text: string) {
  const abs = path.join(root, 'blueprint', file)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function seedPage(): string {
  const outcome = apply(loadBlueprint({}), [listPage()], { ids: sequenceSource() })
  if (!outcome.ok) throw new Error(outcome.error.message)
  const { file, after } = outcome.writes[0]!
  writeBlueprint(file, after!)
  return after!
}

it('FR-AG-01 reports an absent blueprint as an empty starting point', async () => {
  const response = await get()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    ok: true,
    data: { dir: 'blueprint', exists: false, app: null, model: null, pages: [], diagnostics: [], next: expect.stringContaining('createPage') },
  })
  expect(fs.existsSync(path.join(root, 'blueprint'))).toBe(false)
})

it('FR-AG-01 reads a document and its opt-in projection with the disk revision', async () => {
  const text = seedPage()
  const doc = await (await get(pagePath)).json()
  expect(doc).toMatchObject({
    ok: true,
    data: { path: 'pages/Customers.page.json', rev: revOfText(text), doc: { name: 'Customers', resource: 'Customer' } },
  })
  expect(doc.data).not.toHaveProperty('projection')
  const projected = await (await get(`${pagePath}&projection=1`)).json()
  expect(projected.data).toMatchObject({ ...doc.data, projection: expect.stringContaining('Customers') })
})

it('FR-AG-01 distinguishes draft, ejected and edited pages using the lock and disk bytes', async () => {
  const text = seedPage()
  const file = 'src/App.tsx'
  const abs = path.join(root, file)
  const original = fs.readFileSync(abs, 'utf8')
  const page = async () => (await (await get()).json()).data.pages[0]
  expect(await page()).toEqual({
    name: 'Customers', path: listPage().doc, rev: revOfText(text), kind: 'list', route: '/customers',
    status: 'draft', errors: 0, warnings: 0,
  })
  writeBlueprint('blueprint.lock.json', JSON.stringify({
    lockVersion: 1, compiler: '0.3.0', pages: { Customers: { file, hash: revOfText(original), blueprintRev: revOfText(text) } },
  }))
  expect(await page()).toMatchObject({ status: 'ejected', file })
  fs.appendFileSync(abs, '\n')
  expect(await page()).toMatchObject({ status: 'edited', file })
  fs.unlinkSync(abs)
  expect(await page()).toMatchObject({ status: 'edited', file })
})

it('FR-AG-01 serves installed and uninstalled component schemas, slots, events and exposes', async () => {
  writeBlueprint('manifests/CustomSearch.manifest.json', JSON.stringify({
    type: 'CustomSearch', source: { registry: 'local', item: 'search', import: { name: 'CustomSearch', from: './search' } },
    props: [{ name: 'value', kind: 'string', optional: true, source: 'declared' }],
    events: [{ name: 'onChange', prop: 'onChange' }], slots: [{ name: 'children', kind: 'nodes' }],
    exposes: [{ name: 'value', type: 'string', initial: '', via: { valueProp: 'value', changeProp: 'onChange', changeArg: 'value' } }],
    client: true, template: {},
  }))
  const response = await get('/components')
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    ok: true,
    data: {
      components: expect.arrayContaining([
        expect.objectContaining({ type: 'Button', installed: true }),
        {
          type: 'CustomSearch', installed: false, slots: [{ name: 'children', kind: 'nodes' }],
          events: [{ name: 'onChange', prop: 'onChange' }], exposes: [expect.objectContaining({ name: 'value', type: 'string' })],
        },
      ]),
      schemas: { CustomSearch: { properties: { value: { type: 'string' } } }, Button: { properties: { variant: { enum: expect.arrayContaining(['outline']) } } } },
    },
  })
})

it('FR-AG-01 refuses a document from a newer version and reports the supported version', async () => {
  const text = seedPage()
  writeBlueprint(listPage().doc, JSON.stringify({ ...JSON.parse(text), blueprintVersion: 2 }))
  const response = await get(pagePath)
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'unsupported', details: { found: 2, supported: 1 } } })
})
