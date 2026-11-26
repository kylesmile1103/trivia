// HistoryState.lastWriteAt: when the service last wrote the project (docs/api.md). The canvas
// compares it with a Next document's load to tell whether that document can have missed an
// edit (LLD-13 §6).

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
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000)
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-last-write-'))
  service = new EngineService({ host: createStandaloneHost(root), engine: await loadEngine(), version: 'test' })
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(root, { recursive: true, force: true })
})

const HOME = 'src/Home.tsx'
const MAIN = `${HOME}#Home#0`
const className = (value: string, expectedName = 'main') => ({ op: 'updateProp', target: MAIN, expectedName, prop: 'className', value })

it('says when an apply, an undo, a redo or a blueprint write last changed a file', async () => {
  expect(service.history().lastWriteAt).toBeNull()

  vi.setSystemTime(2_000)
  const created = await service.apply({ op: 'createFile', file: HOME, content: 'export function Home() {\n  return <main className="a" />\n}\n' }, 'Add home')
  expect(created.history.lastWriteAt).toBe(2_000)

  vi.setSystemTime(3_000)
  expect((await service.apply(className('b'), 'Restyle')).history.lastWriteAt).toBe(3_000)
  vi.setSystemTime(4_000)
  expect((await service.undo()).history.lastWriteAt).toBe(4_000)
  vi.setSystemTime(5_000)
  expect((await service.redo()).history.lastWriteAt).toBe(5_000)

  vi.setSystemTime(6_000)
  await service.writeDocuments([{ file: 'app.blueprint.json', before: null, after: '{"name":"Orders"}\n' }], 'Add app')
  expect(service.history().lastWriteAt).toBe(6_000)
})

it('stays put for an op that changes nothing, one that is refused, and an undo with nothing to undo', async () => {
  vi.setSystemTime(2_000)
  await service.apply({ op: 'createFile', file: HOME, content: 'export function Home() {\n  return <main className="a" />\n}\n' }, 'Add home')

  vi.setSystemTime(3_000)
  const unchanged = await service.apply(className('a'), 'Same class')
  expect(unchanged.changed).toBe(false)
  expect(unchanged.history.lastWriteAt).toBe(2_000)
  await expect(service.apply(className('b', 'div'), 'Wrong element')).rejects.toMatchObject({ code: 'stale_locator' })
  expect(service.history().lastWriteAt).toBe(2_000)
  await expect(service.writeDocuments([{ file: 'app.blueprint.json', before: '{}', after: '{"name":"Orders"}\n' }], 'Stale'))
    .rejects.toMatchObject({ code: 'conflict' })
  expect(service.history().lastWriteAt).toBe(2_000)

  await service.undo()
  vi.setSystemTime(4_000)
  expect((await service.undo()).files).toEqual([]) // nothing left to undo
  expect(service.history().lastWriteAt).toBe(3_000)
})
