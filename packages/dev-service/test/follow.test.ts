// An edit's `follow` (docs/api.md): where the given locators are after it, from the engine,
// and the agent's published selection moved the same way.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { EngineService } from '../src/api/service.js'
import { type EngineBinding, loadEngine } from '../src/engine.js'
import { createStandaloneHost } from '../src/standalone.js'

const HOME = 'src/Home.tsx'
const at = (p: string) => `${HOME}#Home#${p}`
const PAGE = 'export function Home() {\n  return (\n    <main>\n      <h1>Title</h1>\n      <p>Body</p>\n    </main>\n  )\n}\n'

let root: string
let engine: EngineBinding
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-follow-'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, HOME), PAGE)
  engine = await loadEngine()
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const service = (binding: EngineBinding = engine) => new EngineService({ host: createStandaloneHost(root), engine: binding, version: 'test' })
const insertBefore = { op: 'insert', target: at('0.0'), expectedName: 'h1', placement: 'before', snippet: '<p>Lead</p>' }

it('answers where each followed locator is, in order, and only when asked', async () => {
  const s = service()
  const result = await s.apply(insertBefore, 'Lead', { follow: [at('0.0'), at('0.1'), at('0.7'), 'not a locator'] })
  expect(result.followed).toEqual([at('0.1'), at('0.2'), null, null])
  expect(fs.readFileSync(path.join(root, HOME), 'utf8')).toContain('<p>Lead</p>\n      <h1>Title</h1>')
  const plain = await s.apply({ op: 'setText', target: at('0.1'), expectedName: 'h1', text: 'Heading' }, 'Rename')
  expect(plain).not.toHaveProperty('followed')
})

it('moves an agent\'s selection to where the engine followed it, apart from the caller\'s own', async () => {
  const s = service()
  s.select({ locator: at('0.1'), name: 'p' })
  const result = await s.batch([insertBefore], 'Lead', { by: 'agent', follow: [at('0.0')] })
  expect(result.followed).toEqual([at('0.1')]) // the caller's, without the selection's
  expect(s.selection()).toMatchObject({ selection: { locator: at('0.2'), name: 'p' }, by: 'agent' })
})

it('lets an agent\'s selection go, and says once how to fix it, when the native engine is too old to follow', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    // A binding built before applyOps took followJson ignores it.
    const stale: EngineBinding = { ...engine, applyOps: (r: string, ops: string) => engine.applyOps(r, ops) }
    const s = service(stale)
    s.select({ locator: at('0.1'), name: 'p' })
    const result = await s.apply(insertBefore, 'Lead', { by: 'agent', follow: [at('0.0')] })
    expect(result.changed).toBe(true) // the edit was written: it is not refused
    expect(result.followed).toEqual([null])
    expect(s.selection().selection).toBeNull()
    await s.apply({ op: 'setText', target: at('0.1'), expectedName: 'h1', text: 'Heading' }, 'Rename', { follow: [at('0.1')] })
    expect(warn.mock.calls.filter(([m]) => String(m).includes('pnpm build:engine'))).toHaveLength(1)
  } finally {
    warn.mockRestore()
  }
})
