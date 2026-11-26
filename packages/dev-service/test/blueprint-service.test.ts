import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { EngineService } from '../src/api/service.js'
import { loadEngine } from '../src/engine.js'
import { createStandaloneHost } from '../src/standalone.js'

let root: string
let service: EngineService

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-blueprint-service-'))
  service = new EngineService({ host: createStandaloneHost(root), engine: await loadEngine(), version: 'test' })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

const APP = 'app.blueprint.json'
const PAGE = 'pages/Orders.page.json'
const before = '{ "name": "Café" }\r\n'
const after = '{"name":"Orders"}\n'

function read(file: string): Buffer {
  return fs.readFileSync(path.join(root, 'blueprint', file))
}

function save(file: string, text: string): void {
  const abs = path.join(root, 'blueprint', file)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

it('FR-AG-03 serializes source and blueprint writes in one queue and restores original bytes', async () => {
  save(APP, before)
  const source = { op: 'createFile', file: 'src/Home.tsx', content: 'export const Home = () => <main />\n' }
  const editSource = service.apply(source, 'Add source')
  const editBlueprint = service.writeDocuments([
    { file: APP, before, after },
    { file: PAGE, before: null, after },
  ], 'Add orders')
  const undoBlueprint = service.undo()

  await editSource
  await editBlueprint
  expect(await undoBlueprint).toEqual({
    files: ['blueprint/app.blueprint.json', 'blueprint/pages/Orders.page.json'],
    history: { canUndo: true, canRedo: true, undoLabel: 'Add source', redoLabel: 'Add orders', lastWriteAt: expect.any(Number) },
  })
  expect(read(APP)).toEqual(Buffer.from(before))
  expect(fs.existsSync(path.join(root, 'blueprint', PAGE))).toBe(false)

  expect((await service.redo()).history.undoLabel).toBe('Add orders')
  expect(read(APP)).toEqual(Buffer.from(after))
  expect(read(PAGE)).toEqual(Buffer.from(after))

  await service.undo()
  await service.undo()
  expect(fs.existsSync(path.join(root, source.file))).toBe(false)
})

it('FR-AG-05 refuses a stale byte guard before any file changes', async () => {
  save(APP, before)
  await expect(service.writeDocuments([
    { file: PAGE, before: null, after },
    { file: APP, before: after, after: null },
  ], 'Stale')).rejects.toMatchObject({ code: 'conflict' })
  expect(read(APP)).toEqual(Buffer.from(before))
  expect(fs.existsSync(path.join(root, 'blueprint', 'pages'))).toBe(false)
  expect(service.history().canUndo).toBe(false)
})

it('NFR-12 rolls back a file already committed when a later rename fails', async () => {
  save(APP, before)
  save(PAGE, before)
  const rename = fs.renameSync
  const page = fs.realpathSync(path.join(root, 'blueprint', PAGE))
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === page) {
      expect(read(APP)).toEqual(Buffer.from(after))
      throw Object.assign(new Error('forced rename failure'), { code: 'EIO' })
    }
    rename(from, to)
  })
  await expect(service.writeDocuments([
    { file: APP, before, after },
    { file: PAGE, before, after },
  ], 'Failed')).rejects.toMatchObject({ code: 'io_error', message: expect.stringContaining('forced rename failure') })
  expect(read(APP)).toEqual(Buffer.from(before))
  expect(read(PAGE)).toEqual(Buffer.from(before))
  expect(fs.readdirSync(path.dirname(page))).toEqual(['Orders.page.json'])
  expect(service.history().canUndo).toBe(false)
})

it('FR-AG-03 refuses undo after a hand edit and keeps the undo label', async () => {
  await service.writeDocuments([{ file: PAGE, before: null, after }], 'Add orders')
  save(PAGE, before)
  await expect(service.undo()).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('Add orders') })
  expect(read(PAGE)).toEqual(Buffer.from(before))
  expect(service.history()).toMatchObject({ undoLabel: 'Add orders', canRedo: false })
})

it('NFR-05 refuses a document outside the configured directory', async () => {
  await expect(service.writeDocuments([{ file: '../outside.json', before: null, after }], 'Outside')).rejects.toMatchObject({
    code: 'path_outside_root',
  })
  expect(fs.readdirSync(root)).toEqual([])
})

it('FR-AG-03 checks the expected undo label inside the edit queue', async () => {
  await service.writeDocuments([{ file: APP, before: null, after: before }], 'First')
  const pending = service.writeDocuments([{ file: APP, before, after }], 'Second')
  const undo = service.undo('First')
  await pending
  await expect(undo).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('Second') })
  expect(read(APP)).toEqual(Buffer.from(after))
  expect(service.history().undoLabel).toBe('Second')
})
