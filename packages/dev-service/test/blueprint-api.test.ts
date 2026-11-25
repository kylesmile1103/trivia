import fs from 'node:fs'
import path from 'node:path'

import { apply, loadBlueprint, revOfText, sequenceSource } from '@trivia/blueprint'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { createStandaloneHost, startDevService, type RunningDevService } from '../src/standalone.js'
import { copyBlueprintProject, listPage } from './blueprint-fixture.js'

let root: string
let running: RunningDevService

beforeEach(async () => {
  root = copyBlueprintProject()
  running = await startDevService(createStandaloneHost(root))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await running?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const get = (suffix = '') => fetch(`${running.url}/@trivia/api/blueprint${suffix}`)
const post = (suffix: string, body: unknown) => fetch(`${running.url}/@trivia/api/blueprint${suffix}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
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
  const doc = await (await get(pagePath)).json() as { data: Record<string, unknown> }
  expect(doc).toMatchObject({
    ok: true,
    data: { path: 'pages/Customers.page.json', rev: revOfText(text), doc: { name: 'Customers', resource: 'Customer' } },
  })
  expect(doc.data).not.toHaveProperty('projection')
  const projected = await (await get(`${pagePath}&projection=1`)).json() as { data: Record<string, unknown> }
  expect(projected.data).toMatchObject({ ...doc.data, projection: expect.stringContaining('Customers') })
})

it('FR-AG-01 distinguishes draft, ejected and edited pages using the lock and disk bytes', async () => {
  const text = seedPage()
  const file = 'src/App.tsx'
  const abs = path.join(root, file)
  const original = fs.readFileSync(abs, 'utf8')
  const page = async () => {
    const summary = await (await get()).json() as { data: { pages: unknown[] } }
    return summary.data.pages[0]
  }
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

it('FR-AG-04 saves a first draft with contract errors and returns usable diagnostics', async () => {
  const orders = listPage('Orders', 'Order')
  const rootDir = path.join(root, 'blueprint')
  expect(fs.existsSync(rootDir)).toBe(false)
  const response = await post('/patch', { ops: [orders], label: 'Add orders' })
  expect(response.status).toBe(200)

  const text = fs.readFileSync(path.join(rootDir, orders.doc), 'utf8')
  const rev = revOfText(text)
  const finding = expect.objectContaining({
    code: 'unknown_resource', severity: 'error', doc: orders.doc, pointer: '/resource',
    hint: { text: 'Known resources: Account, Customer, Transaction.' },
  })
  expect(await response.json()).toMatchObject({
    ok: true,
    data: {
      entry: 'Add orders', changed: true, revs: { [orders.doc]: rev }, created: { Orders: JSON.parse(text).id },
      diagnostics: expect.arrayContaining([finding]),
      summary: { exists: true, pages: [{ name: 'Orders', status: 'draft', rev, errors: 1 }], diagnostics: expect.arrayContaining([finding]), next: expect.stringContaining('diagnostics') },
    },
  })
  expect(await (await get(`/doc?path=${orders.doc}`)).json()).toMatchObject({ ok: true, data: { rev, doc: { resource: 'Order' } } })
})

it('FR-AG-01 refuses a structurally invalid patch without creating the directory', async () => {
  const response = await post('/patch', {
    label: 'Create colliding routes',
    ops: [listPage(), { ...listPage('Accounts', 'Account'), route: '/customers' }],
  })
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({
    ok: false, error: { code: 'invalid_result', details: { diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'duplicate_route' })]) } },
  })
  expect(fs.existsSync(path.join(root, 'blueprint'))).toBe(false)
})

const setResource = (doc: string, baseRev: string, resource: string) => ({ op: 'setPageMeta', doc, baseRev, resource })

it('FR-AG-05 lets only one of two concurrent writes from the same read succeed', async () => {
  const initial = seedPage()
  const doc = listPage().doc
  const ops = ['Account', 'Transaction'].map((name) => setResource(doc, revOfText(initial), name))
  const results = await Promise.all(ops.map((op) => post('/patch', { label: 'Change resource', ops: [op] })))
  expect(results.map(({ status }) => status).sort()).toEqual([200, 409])
  const winner = ops[results.findIndex(({ status }) => status === 200)]!
  const disk = fs.readFileSync(path.join(root, 'blueprint', doc), 'utf8')
  expect(JSON.parse(disk).resource).toBe(winner.resource)
  const conflict = results.find(({ status }) => status === 409)!
  expect(await conflict.json()).toMatchObject({ error: { code: 'conflict', details: { revs: { [doc]: revOfText(disk) } } } })
})

it('FR-AG-05 reports the revision of a hand edit without overwriting its bytes', async () => {
  const initial = seedPage()
  const doc = listPage().doc
  const edited = initial + '\n'
  writeBlueprint(doc, edited)
  const response = await post('/patch', { label: 'Change resource', ops: [setResource(doc, revOfText(initial), 'Account')] })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { revs: { [doc]: revOfText(edited) } } } })
  expect(fs.readFileSync(path.join(root, 'blueprint', doc), 'utf8')).toBe(edited)
})

it('FR-AG-05 reports all three revisions and preserves the batch when the last guard is stale', async () => {
  const pages = [listPage(), listPage('Accounts', 'Account'), listPage('Transactions', 'Transaction')]
  const outcome = apply(loadBlueprint({}), pages, { ids: sequenceSource() })
  if (!outcome.ok) throw new Error(outcome.error.message)
  const current = outcome.result.revs
  for (const { file, after } of outcome.writes) writeBlueprint(file, after!)
  const ops = pages.map(({ doc }, i) => setResource(doc, i === 2 ? 'sha256:' + '0'.repeat(64) : current[doc]!, 'Order'))
  const response = await post('/patch', { label: 'Change three documents', ops })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { revs: current } } })
  for (const { file, after } of outcome.writes) {
    expect(fs.readFileSync(path.join(root, 'blueprint', file), 'utf8')).toBe(after)
  }
})

it('FR-AG-05 includes revisions when the byte guard detects an edit after planning', async () => {
  const initial = seedPage()
  const doc = listPage().doc
  const edited = initial + '\n'
  const lock = 'blueprint.lock.json'
  writeBlueprint(lock, JSON.stringify({ lockVersion: 1, pages: {} }))
  const read = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
    if (args[0] === path.join(root, 'blueprint', lock)) writeBlueprint(doc, edited)
    return read(...args)
  })
  const response = await post('/patch', { label: 'Change resource', ops: [setResource(doc, revOfText(initial), 'Account')] })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { revs: { [doc]: revOfText(edited) } } } })
  expect(fs.readFileSync(path.join(root, 'blueprint', doc), 'utf8')).toBe(edited)
})

it('NFR-05 refuses traversal, absolute paths and paths through symlinks', async () => {
  fs.mkdirSync(path.join(root, 'blueprint'))
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'blueprint', 'symlink'), 'junction')
  for (const file of ['../trivia.manifest.json', '/app.blueprint.json', 'C:\\outside.json', 'symlink/App.tsx', 'pages//Customers.page.json']) {
    const response = await get(`/doc?path=${encodeURIComponent(file)}`)
    expect(response.status, file).toBe(422)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'path_outside_root' } })
  }
})

it.each([
  ['/preview', { page: 'Customers' }, '005'],
  ['/plan', { pages: ['Customers'] }, '005'],
  ['/ejected', { pages: ['Customers'], entry: 'Eject customers' }, '005'],
  ['/backend', { mode: 'plan' }, '009'],
])('FR-AG-01 reserves %s and reports the spec that provides it', async (route, body, spec) => {
  const response = await post(route, body)
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'unsupported', message: expect.stringContaining(`spec ${spec}`) } })
  expect(fs.existsSync(path.join(root, 'blueprint'))).toBe(false)
})
