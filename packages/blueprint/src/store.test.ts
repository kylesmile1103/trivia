import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

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
