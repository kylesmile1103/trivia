import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { loadBlueprint, SCHEMA_URL, type ContractOptions } from '@trivia/blueprint'
import { compilePage, projectFacts, type CompileContext } from '@trivia/blueprint-compiler'
import { generateRefinePage, loadEngine } from '@trivia/dev-service'
import { expect, it } from 'vitest'

import { REFINE_ADMIN, copyRefineAdmin, post, startServer } from './helpers.js'

async function contextFor(root: string): Promise<CompileContext> {
  const contract: NonNullable<CompileContext['contract']> = JSON.parse(fs.readFileSync(path.join(root, 'trivia.manifest.json'), 'utf8'))
  const typesImport = contract.modules.types?.importPath
  if (!typesImport) throw new Error('Fixture contract must have generated types')
  return {
    contract, engine: await loadEngine(), facts: projectFacts(),
    generateContractPage: (input) => generateRefinePage({
      ...input,
      project: {
        ui: '@/components/ui', refineUi: '@/components/refine-ui', textarea: true,
        pagesDir: 'src/pages', pagesImport: '@/pages', typesImport,
      },
    }),
  }
}

it('FR-RC-02: compiles all four default pages byte for byte as refine/pages/plan', async () => {
  const root = copyRefineAdmin()
  try {
    const app = path.join(root, 'src/App.tsx')
    fs.writeFileSync(app, fs.readFileSync(app, 'utf8')
      .replace(/^.*AccountList.*\n/gm, '')
      .replace(/^.*list: "\/accounts",\n/m, ''))
    fs.rmSync(path.join(root, 'src/pages/accounts/list.tsx'))
    const server = await startServer(root)
    try {
      const context = await contextFor(root)
      const kinds = ['list', 'create', 'edit', 'show'] as const
      const plan = await post(server.socket, '/refine/pages/plan', { resource: 'Account', pages: kinds })
      expect(plan.status, JSON.stringify(plan.body)).toBe(200)
      const blueprint = loadBlueprint(Object.fromEntries(kinds.map((kind, i) => {
        const name = 'Account' + kind[0]!.toUpperCase() + kind.slice(1)
        const route = kind === 'list' ? '/accounts' : '/accounts/' + kind + (kind === 'create' ? '' : '/:id')
        return ['pages/' + name + '.page.json', JSON.stringify({
          $schema: SCHEMA_URL.page, blueprintVersion: 1, name, route, kind, resource: 'Account',
          id: 'pg_0000000000000000000000000' + i,
        })]
      })))
      for (const kind of kinds) {
        const name = 'Account' + kind[0]!.toUpperCase() + kind.slice(1)
        const op = plan.body.data.ops.find((op: { file?: string }) => op.file === 'src/pages/accounts/' + kind + '.tsx')
        expect(compilePage(blueprint, name, context)).toMatchObject({ file: op.file, code: op.content })
      }
    } finally {
      await server.close()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

function accountPage(kind: 'list' | 'create' | 'edit' | 'show', options: ContractOptions) {
  return loadBlueprint({ 'pages/Account.page.json': JSON.stringify({
    $schema: SCHEMA_URL.page, blueprintVersion: 1, id: 'pg_00000000000000000000000000',
    name: 'Account', route: '/accounts', kind, resource: 'Account', options,
  }) })
}

it('FR-RC-02: sends the blueprint field selection, exclusions and title to the shared generator', async () => {
  const context = await contextFor(REFINE_ADMIN)
  const list = compilePage(accountPage('list', {
    fields: ['currency', 'status', 'type'], hideFields: ['status'], title: 'Ledger',
  }), 'Account', context).code
  expect([...list.matchAll(/accessorKey: "([^"]+)"/g)].map((match) => match[1])).toEqual(['currency', 'type'])
  expect(list).toContain('<ListViewHeader title="Ledger"')

  const create = compilePage(accountPage('create', {
    fields: ['type', 'currency'], hideFields: ['currency'],
  }), 'Account', context).code
  expect(create).toContain('name="type"')
  expect(create).not.toContain('name="customerId"')
  expect(create).not.toContain('name="currency"')

  const show = compilePage(accountPage('show', { fields: ['id'] }), 'Account', context).code
  expect(show).toContain('record?.id')
  expect(show).not.toContain('record?.currency')
})

it('FR-RC-02: filters selected columns and puts typed action buttons in rows and headers', async () => {
  const context = await contextFor(REFINE_ADMIN)
  const emitted = compilePage(accountPage('list', {
    fields: ['iban', 'type'],
    filters: ['type'],
    rowActions: [{ name: 'applyCurrency', label: 'Apply currency', confirm: 'Apply it?', steps: [
      { do: 'mutate', resource: 'Account', operation: 'update', id: 'row.id', input: '{ currency: row.currency }' },
    ] }],
    headerActions: [{ name: 'help', label: 'Help', steps: [
      { do: 'toast', message: '"About accounts"', variant: 'success' },
    ] }],
  }), 'Account', context)
  expect(emitted.code).toContain('DataTableFilterCombobox')
  expect(emitted.code).not.toContain('DataTableFilterDropdownText')
  expect(emitted.code).toContain('>Apply currency</Button>')
  expect(emitted.code).toContain('>Help</Button>')
  expect(emitted.code).toContain('window.confirm("Apply it?")')
  expect(emitted.code).toMatch(/await .*mutateAsync\(\{ resource: "accounts", id: .*\.id, values: \{ currency: .*\.currency \} \}\)/)

  const root = copyRefineAdmin()
  try {
    fs.writeFileSync(path.join(root, emitted.file), emitted.code)
    execFileSync(process.execPath, [path.join(REFINE_ADMIN, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.app.json', '--noEmit'], {
      cwd: root, encoding: 'utf8',
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

it('FR-RC-06: provides a Vite preview route without writing any app source', async () => {
  const root = copyRefineAdmin()
  const server = await startServer(root)
  try {
    const file = path.join(root, 'src/App.tsx')
    const before = fs.readFileSync(file)
    const name = 'DraftPage'
    const patched = await post(server.socket, '/blueprint/patch', {
      label: 'Draft preview',
      ops: [{ op: 'createPage', doc: 'pages/DraftPage.page.json', baseRev: null, name, route: '/draft', kind: 'custom' }],
    })
    expect(patched.status).toBe(200)
    const preview = await post(server.socket, '/blueprint/preview', { page: name })
    expect(preview.status, JSON.stringify(preview.body)).toBe(200)
    expect(preview.body.data).toMatchObject({
      page: name, route: '/__blueprint/DraftPage',
      module: expect.stringMatching(/^\/@trivia\/preview\/.+\.tsx$/),
      code: expect.stringContaining('export function DraftPage()'),
    })
    const app = await server.vite.transformRequest('/src/App.tsx')
    expect(app?.code).toContain('/__blueprint/:triviaPage')
    expect(fs.readFileSync(file)).toEqual(before)
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

it('FR-RC-06: Vite transforms fresh preview code and reports invalid drafts with diagnostics', async () => {
  const root = copyRefineAdmin()
  const server = await startServer(root)
  try {
    const doc = 'pages/PreviewChanges.page.json'
    const page = 'PreviewChanges'
    const patch = (ops: unknown[]) => post(server.socket, '/blueprint/patch', { label: 'Change draft', ops })
    const initial = await patch([{ op: 'createPage', doc, baseRev: null, name: page, route: '/changes', kind: 'custom' }])
    expect(initial.status).toBe(200)
    const node = initial.body.data.created[page + '/page']
    const after = await patch([
      { op: 'setProp', doc, baseRev: initial.body.data.revs[doc], node, expectedType: 'div', prop: 'children', value: 'Before draft' },
      { op: 'setStyle', doc, baseRev: initial.body.data.revs[doc], node, expectedType: 'div', className: 'text-violet-700' },
    ])
    expect(after.status, JSON.stringify(after.body)).toBe(200)
    const preview = await post(server.socket, '/blueprint/preview', { page })
    expect(preview.status).toBe(200)
    const url = preview.body.data.module as string
    const before = await server.vite.transformRequest(url)
    expect(before?.code).toContain('Before draft')
    expect(before?.code).toContain('export default PreviewChanges')
    expect(before?.code).toContain('.css')

    const changed = await patch([
      { op: 'setProp', doc, baseRev: after.body.data.revs[doc], node, expectedType: 'div', prop: 'children', value: 'After draft' },
    ])
    expect(changed.status).toBe(200)
    expect((await server.vite.transformRequest(url))?.code).toContain('After draft')

    const invalid = await patch([
      { op: 'setBinding', doc, baseRev: changed.body.data.revs[doc], node, expectedType: 'div', prop: 'children', expr: 'state.unknown' },
    ])
    expect(invalid.status, JSON.stringify(invalid.body)).toBe(200)
    const refused = await post(server.socket, '/blueprint/preview', { page })
    expect(refused.status).toBe(422)
    expect(refused.body.error).toMatchObject({
      code: 'invalid_result', details: { diagnostics: [expect.objectContaining({
        doc, pointer: '/bindings/' + node + '/children', severity: 'error',
      })] },
    })
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

it('FR-RC-07: commits the lock with the batch and refuses an intervening draft edit', async () => {
  const root = copyRefineAdmin()
  const server = await startServer(root)
  try {
    const file = 'pages/Planned.page.json'
    const lock = path.join(root, 'blueprint/blueprint.lock.json')
    const patch = (ops: unknown[]) => post(server.socket, '/blueprint/patch', { label: 'Planned draft', ops })
    const created = await patch([{ op: 'createPage', doc: file, baseRev: null, name: 'Planned', route: '/planned', kind: 'custom' }])
    expect(created.status).toBe(200)
    const plan = () => post(server.socket, '/blueprint/plan', { pages: ['Planned'] })
    const old = await plan()
    expect(old.status, JSON.stringify(old.body)).toBe(200)
    expect(fs.existsSync(lock)).toBe(false)
    expect((await patch([{ op: 'setProp', doc: file, baseRev: created.body.data.revs[file],
      node: created.body.data.created['Planned/page'], expectedType: 'div', prop: 'children', value: 'Fresh',
    }])).status).toBe(200)

    const apply = (planned: any) => post(server.socket, '/batch', { ops: planned.ops, label: planned.label })
    const stale = await apply(old.body.data)
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({ code: 'conflict', details: { revs: expect.any(Object) } })
    expect(fs.existsSync(lock)).toBe(false)
    expect(fs.existsSync(path.join(root, old.body.data.files[0]))).toBe(false)

    const fresh = await plan()
    expect(fresh.status).toBe(200)
    expect((await apply(fresh.body.data)).status).toBe(200)
    expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toEqual(fresh.body.data.lock)
    const confirmed = await post(server.socket, '/blueprint/ejected', { pages: ['Planned'], entry: fresh.body.data.label })
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200)
    expect(confirmed.body.data.lockRev).toMatch(/^sha256:[a-f0-9]{64}$/)
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

it('SC-003: ejects four CRUD pages and restores every touched byte on undo and redo', async () => {
  const root = copyRefineAdmin()
  const app = path.join(root, 'src/App.tsx')
  fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace(/^.*AccountList.*\n/gm, '')
    .replace(/          \{\n            name: "accounts",[\s\S]*?\n          \},\n/, ''))
  fs.rmSync(path.join(root, 'src/pages/accounts/list.tsx'))
  const server = await startServer(root)
  try {
    const previous = fs.readFileSync(app)
    const kinds = ['list', 'create', 'edit', 'show'] as const
    const names = kinds.map((kind) => 'Account' + kind[0]!.toUpperCase() + kind.slice(1))
    const patch = await post(server.socket, '/blueprint/patch', {
      label: 'Draft CRUD',
      ops: kinds.map((kind, index) => ({
        op: 'createPage', doc: 'pages/' + names[index] + '.page.json', baseRev: null,
        name: names[index], resource: 'Account', kind,
        route: kind === 'list' ? '/accounts' : '/accounts/' + kind + (kind === 'create' ? '' : '/:id'),
      })),
    })
    expect(patch.status).toBe(200)
    const planned = await post(server.socket, '/blueprint/plan', { pages: names })
    expect(planned.status, JSON.stringify(planned.body)).toBe(200)
    const { ops, label, files } = planned.body.data
    expect(files).toHaveLength(4)
    expect(ops.filter((op: { op: string }) => op.op === 'insertElement')).toHaveLength(1)
    expect(ops.filter((op: { op: string }) => op.op === 'insert')).toHaveLength(4)
    expect((await post(server.socket, '/batch', { ops, label })).status).toBe(200)
    const lock = path.join(root, 'blueprint/blueprint.lock.json')
    const created = [lock, ...files.map((file: string) => path.join(root, file))]
    const ejected = [app, ...created].map((file) => fs.readFileSync(file))
    execFileSync(process.execPath, [path.join(REFINE_ADMIN, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.app.json', '--noEmit'], { cwd: root })
    expect((await post(server.socket, '/undo')).status).toBe(200)
    expect(fs.readFileSync(app)).toEqual(previous)
    expect(created.some((file) => fs.existsSync(file))).toBe(false)
    expect((await post(server.socket, '/redo')).status).toBe(200)
    expect([app, ...created].map((file) => fs.readFileSync(file))).toEqual(ejected)

    const missing = path.join(root, 'src/pages/accounts/list.tsx')
    fs.rmSync(missing)
    const restore = await post(server.socket, '/blueprint/plan', { pages: ['AccountList'] })
    expect(restore.status, JSON.stringify(restore.body)).toBe(200)
    expect((await post(server.socket, '/batch', { ops: restore.body.data.ops, label: restore.body.data.label })).status).toBe(200)
    const confirmed = await post(server.socket, '/blueprint/ejected', { pages: ['AccountList'], entry: restore.body.data.label })
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200)
    expect([app, ...created].map((file) => fs.readFileSync(file))).toEqual(ejected)
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it('FR-RC-02: a list header action can refetch the current table query', async () => {
  const context = await contextFor(REFINE_ADMIN)
  const emitted = compilePage(accountPage('list', {
    headerActions: [{ name: 'refresh', label: 'Refresh', steps: [{ do: 'refetch', query: 'list' }] }],
  }), 'Account', context)
  expect(emitted.code).toContain('await table.refineCore.tableQuery.refetch();')
  expect(emitted.code).toContain('>Refresh</Button>')

  const root = copyRefineAdmin()
  try {
    fs.writeFileSync(path.join(root, emitted.file), emitted.code)
    execFileSync(process.execPath, [path.join(REFINE_ADMIN, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.app.json', '--noEmit'], {
      cwd: root, encoding: 'utf8',
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
