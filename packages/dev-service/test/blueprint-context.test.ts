import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it } from 'vitest'

import { EngineService } from '../src/api/service.js'
import { loadEngine } from '../src/engine.js'
import { createStandaloneHost } from '../src/standalone.js'

let root: string
let service: EngineService
const app = { op: 'setApp', doc: 'app.blueprint.json', baseRev: null, name: 'Bank', targets: { web: 'vite-refine' } } as const

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

it('FR-RC-02 accepts the implicit list query in row and header actions', async () => {
  const action = { name: 'refresh', label: 'Refresh', steps: [{ do: 'refetch' as const, query: 'list' }] }
  const result = await service.blueprint.apply([app, {
    op: 'createPage', doc: 'pages/Customers.page.json', baseRev: null, name: 'Customers', route: '/customers',
    kind: 'list', resource: 'Customer', options: { rowActions: [action], headerActions: [action] },
  }])
  expect(result).toMatchObject({ ok: true, result: { diagnostics: [] } })
})

it.each([
  ['list', '/customers', 'rowActions', 'customers'],
  ['list', '/customers', 'headerActions', 'customers'],
  ['create', '/customers/new', 'rowActions', 'list'],
  ['create', '/customers/new', 'headerActions', 'list'],
  ['edit', '/customers/:id/edit', 'headerActions', 'list'],
  ['show', '/customers/:id', 'headerActions', 'list'],
] as const)('FR-RC-02 refuses %s refetch at %s in %s for query %s', async (kind, route, group, query) => {
  const doc = 'pages/Customers.page.json'
  const result = await service.blueprint.apply([app, {
    op: 'createPage', doc, baseRev: null, name: 'Customers', route, kind, resource: 'Customer',
    options: { [group]: [{ name: 'refresh', label: 'Refresh', steps: [{ do: 'refetch', query }] }] },
  }])
  expect(result).toMatchObject({ ok: true, result: { diagnostics: [{
    code: 'unsupported_operation', severity: 'error', doc, pointer: `/options/${group}/0/steps/0/query`,
    message: `No query "${query}" to refetch here`,
    hint: { text: 'Use query "list" in row or header actions on a list page.' },
  }] } })
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
