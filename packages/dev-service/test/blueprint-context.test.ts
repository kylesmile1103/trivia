import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it } from 'vitest'

import { EngineService } from '../src/api/service.js'
import { loadEngine } from '../src/engine.js'
import { createStandaloneHost } from '../src/standalone.js'

let root: string
let service: EngineService

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-blueprint-context-'))
  const fixture = path.resolve(import.meta.dirname, '../../../examples/refine-admin')
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true })
  fs.cpSync(path.join(fixture, 'src/components/ui'), path.join(root, 'src/components/ui'), { recursive: true })
  for (const file of ['components.json', 'trivia.manifest.json']) fs.copyFileSync(path.join(fixture, file), path.join(root, file))
  service = new EngineService({
    host: createStandaloneHost(root), engine: await loadEngine(), version: 'test', blueprintDir: 'drafts',
  })
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

it('FR-AG-04 reports contract diagnostics and names the known resources', async () => {
  const outcome = await service.blueprint.apply([
    { op: 'createPage', doc: 'pages/Orders.page.json', baseRev: null, name: 'Orders', route: '/orders', kind: 'list', resource: 'Order' },
  ])
  expect(outcome).toMatchObject({
    ok: true,
    result: {
      diagnostics: expect.arrayContaining([expect.objectContaining({
        code: 'unknown_resource', doc: 'pages/Orders.page.json', pointer: '/resource',
        hint: { text: expect.stringContaining('Account, Customer, Transaction') },
      })]),
    },
  })
  expect(fs.existsSync(path.join(root, 'drafts'))).toBe(false)
})

it('uses the native analyzer and validates binding expressions from the configured directory', async () => {
  const outcome = await service.blueprint.apply([
    { op: 'createPage', doc: 'pages/Lead.page.json', baseRev: null, name: 'Lead', route: '/lead', kind: 'custom' },
  ])
  if (!outcome.ok) throw new Error(outcome.error.message)
  await service.writeDocuments(outcome.writes, 'Lead')
  const file = 'pages/Lead.page.json'
  expect(fs.existsSync(path.join(root, 'drafts', file))).toBe(true)
  const node = outcome.result.created['Lead/page']
  const result = await service.blueprint.apply([{
    op: 'setBinding', doc: file, baseRev: outcome.result.revs[file], node, expectedType: 'div', prop: 'title', expr: 'state.absent',
  }])
  expect(result).toMatchObject({
    ok: true,
    result: { diagnostics: expect.arrayContaining([expect.objectContaining({
      code: 'expr_unknown_member', doc: file, pointer: `/bindings/${node}/title`, span: { start: 6, end: 12, unit: 'utf16' },
    })]) },
  })
})
