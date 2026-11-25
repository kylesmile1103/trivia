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
