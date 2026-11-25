import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { lineDiff } from '../test/helpers.js'
import { sequenceSource } from './ids.js'
import { revOfText } from './serialize.js'
import { createStore, loadBlueprint, readBlueprintFiles } from './store.js'

const fixture = path.resolve(import.meta.dirname, '../fixtures/valid/backoffice')
const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-blueprint-'))
  temps.push(dir)
  fs.cpSync(fixture, dir, { recursive: true })
  return dir
}

describe('store.read() (US1)', () => {
  it('loads every document of the fixture with its rev', async () => {
    const bp = await createStore({ dir: fixture }).read()
    expect(bp.exists).toBe(true)
    expect(Object.keys(bp.docs)).toEqual(['app.blueprint.json', 'pages/CustomerList.page.json', 'pages/CustomerOverview.page.json'])
    for (const entry of Object.values(bp.docs)) {
      const text = fs.readFileSync(path.join(fixture, entry.path), 'utf8')
      expect(entry.text).toBe(text)
      expect(entry.rev).toBe(revOfText(text))
      expect(entry.diagnostics).toEqual([])
      expect(entry.doc).not.toBeNull()
    }
    expect(bp.docs['pages/CustomerOverview.page.json']?.kind).toBe('page')
    expect(bp.docs['app.blueprint.json']?.kind).toBe('app')
  })

  it('loads the other documents when one file is malformed, and reports it without throwing', async () => {
    const dir = copyFixture()
    fs.writeFileSync(path.join(dir, 'pages/CustomerList.page.json'), '{ "name": "CustomerList", ')
    const bp = await createStore({ dir }).read()
    const broken = bp.docs['pages/CustomerList.page.json']
    expect(broken?.doc).toBeNull()
    expect(broken?.rev).toBe(revOfText('{ "name": "CustomerList", '))
    expect(broken?.diagnostics).toMatchObject([{ code: 'invalid_json', severity: 'error', doc: 'pages/CustomerList.page.json', pointer: '' }])
    expect(bp.docs['pages/CustomerOverview.page.json']?.doc).not.toBeNull()
    expect(bp.docs['app.blueprint.json']?.doc).not.toBeNull()
  })

  it('reports a document that fails its schema and keeps its parsed value', () => {
    const bp = loadBlueprint({ 'pages/Bad.page.json': '{ "kind": "list" }\n' })
    expect(bp.docs['pages/Bad.page.json']?.doc).toBeNull()
    expect(bp.docs['pages/Bad.page.json']?.value).toEqual({ kind: 'list' })
    expect(bp.docs['pages/Bad.page.json']?.diagnostics.every((d) => d.code === 'schema_violation')).toBe(true)
  })

  it('reads a missing directory and an empty one as an empty blueprint', async () => {
    const missing = await createStore({ dir: path.join(os.tmpdir(), 'trivia-blueprint-missing-' + process.pid) }).read()
    expect(missing).toEqual({ exists: false, docs: {} })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-blueprint-'))
    temps.push(dir)
    expect(await createStore({ dir }).read()).toEqual({ exists: true, docs: {} })
  })

  it('sees a hand edit as a new rev on the next read', async () => {
    const dir = copyFixture()
    const store = createStore({ dir })
    const before = (await store.read()).docs['app.blueprint.json']?.rev
    const file = path.join(dir, 'app.blueprint.json')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"Customers"', '"Clients"'))
    expect((await store.read()).docs['app.blueprint.json']?.rev).not.toBe(before)
  })

  it('reports files in pages/ that are not page documents, and ignores the lock and manifests', async () => {
    const dir = copyFixture()
    fs.writeFileSync(path.join(dir, 'pages/notes.txt'), 'hello')
    fs.writeFileSync(path.join(dir, 'blueprint.lock.json'), '{}')
    fs.mkdirSync(path.join(dir, 'manifests'))
    fs.writeFileSync(path.join(dir, 'manifests/Card.manifest.json'), '{}')
    const files = await readBlueprintFiles(dir)
    expect(Object.keys(files ?? {})).toEqual([
      'app.blueprint.json', 'pages/CustomerList.page.json', 'pages/CustomerOverview.page.json', 'pages/notes.txt',
    ])
    const bp = loadBlueprint(files ?? {})
    expect(bp.docs['pages/notes.txt']).toMatchObject({ kind: 'unknown', doc: null })
    expect(bp.docs['pages/notes.txt']?.diagnostics).toMatchObject([{ code: 'unknown_document', severity: 'warning' }])
  })
})

const OVERVIEW = 'pages/CustomerOverview.page.json'
const LIST = 'pages/CustomerList.page.json'
const node = (i: number) => `n_01JDK3M8A0000000000000000${i}`

/** What a caller does with the writes (LLD-04): check `before`, then write `after`. */
function perform(dir: string, writes: ReadonlyArray<{ file: string; before: string | null; after: string | null }>) {
  for (const w of writes) {
    const file = path.join(dir, w.file)
    expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null).toBe(w.before)
    if (w.after === null) fs.rmSync(file)
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, w.after)
    }
  }
}

describe('store.apply() (T019)', () => {
  it('returns the writes without performing them; performed, the next read sees the new revs', async () => {
    const dir = copyFixture()
    const store = createStore({ dir, ids: sequenceSource() })
    const before = await store.read()
    const outcome = await store.apply([{ op: 'setPageMeta', doc: LIST, baseRev: before.docs[LIST]?.rev, public: true }])
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
    expect(fs.readFileSync(path.join(dir, LIST), 'utf8')).toBe(before.docs[LIST]?.text)
    expect(outcome.writes.map((w) => w.file)).toEqual([LIST])
    perform(dir, outcome.writes)
    const after = await store.read()
    expect(after.docs[LIST]?.rev).toBe(outcome.result.revs[LIST])
  })

  it('reads the files again on every apply, so a second patch from the same read is refused', async () => {
    const dir = copyFixture()
    const store = createStore({ dir, ids: sequenceSource() })
    const read = await store.read()
    const op = { op: 'setPageMeta', doc: LIST, baseRev: read.docs[LIST]?.rev }
    const first = await store.apply([{ ...op, public: true }])
    perform(dir, first.ok ? first.writes : [])
    const second = await store.apply([{ ...op, route: '/clients' }])
    expect(second.ok ? 'applied' : second.error.code).toBe('conflict')
  })

  it('computes the first write of a blueprint that does not exist yet', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-blueprint-'))
    temps.push(parent)
    const outcome = await createStore({ dir: path.join(parent, 'blueprint'), ids: sequenceSource() }).apply([
      { op: 'createPage', doc: 'pages/Orders.page.json', baseRev: null, name: 'Orders', route: '/orders', kind: 'list', resource: 'Order' },
    ])
    expect(outcome.ok && outcome.writes.map((w) => [w.file, w.before])).toEqual([['pages/Orders.page.json', null]])
  })
})

describe('diff locality (SC-002, NFR-11)', () => {
  // Each op changes one existing node; its diff must stay within six lines of one file.
  const single: Array<[string, Record<string, unknown>]> = [
    ['moveNode to another parent', { op: 'moveNode', node: node(9), expectedType: 'Button', parent: node(2), slot: 'children', before: node(3) }],
    ['moveNode among siblings', { op: 'moveNode', node: node(8), expectedType: 'Button', parent: node(1), slot: 'children', index: 0 }],
    ['renameNode', { op: 'renameNode', node: node(4), expectedType: 'Button', name: 'reload' }],
    ['setProp', { op: 'setProp', node: node(4), expectedType: 'Button', prop: 'variant', value: 'ghost' }],
    ['setBinding', { op: 'setBinding', node: node(4), expectedType: 'Button', prop: 'disabled', expr: 'state.selectedId === null' }],
    ['setStyle', { op: 'setStyle', node: node(4), expectedType: 'Button', className: 'ml-auto' }],
    ['setControl', { op: 'setControl', node: node(4), expectedType: 'Button', control: { when: 'data.customers.total > 10' } }],
    ['setActions', { op: 'setActions', node: node(4), expectedType: 'Button', event: 'onClick', steps: [{ do: 'refetch', query: 'customers' }] }],
  ]
  for (const [name, op] of single) {
    it(name, async () => {
      const store = createStore({ dir: fixture, ids: sequenceSource() })
      const bp = await store.read()
      const outcome = await store.apply([{ doc: OVERVIEW, baseRev: bp.docs[OVERVIEW]?.rev, ...op }])
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
      expect(outcome.writes.map((w) => w.file)).toEqual([OVERVIEW])
      const lines = lineDiff(outcome.writes[0]?.before ?? '', outcome.writes[0]?.after ?? '')
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.length).toBeLessThanOrEqual(6)
    })
  }
})
