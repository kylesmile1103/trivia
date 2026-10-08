// New resource pages (docs/product.md, slice 4) on a copy of examples/refine-admin: a resource's
// missing pages from the contract, registered in <Refine resources> and the routes, as one undo
// entry; the generated pages type-check.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { REFINE_ADMIN, copyRefineAdmin, get, post, startServer, type TestServer } from './helpers.js'

let root: string
let server: TestServer

beforeAll(async () => {
  root = copyRefineAdmin()
  server = await startServer(root)
})

afterAll(async () => {
  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const exists = (file: string) => fs.existsSync(path.join(root, file))
const plan = (resource: string, pages?: string[]) => post(server.socket, '/refine/pages/plan', { resource, ...(pages ? { pages } : {}) })
const apply = async (resource: string, pages?: string[]) => {
  const planned = await plan(resource, pages)
  expect(planned.status, JSON.stringify(planned.body)).toBe(200)
  const applied = await post(server.socket, '/batch', { ops: planned.body.data.ops, label: planned.body.data.label })
  expect(applied.status, JSON.stringify(applied.body)).toBe(200)
  return { plan: planned.body.data, result: applied.body.data }
}
const typecheck = () => {
  try {
    execFileSync(path.join(REFINE_ADMIN, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.app.json', '--noEmit'], { cwd: root, encoding: 'utf8' })
  } catch (error) {
    throw new Error(`the generated pages do not type-check:\n${(error as { stdout?: string }).stdout}`)
  }
}

describe('resource pages', () => {
  it('lists each contract resource with the pages it has and could have', async () => {
    const reply = await get(server.socket, '/refine/resources')
    expect(reply.body.data).toEqual([
      { resource: 'Account', name: 'accounts', existing: ['list'], possible: ['list', 'create', 'edit', 'show'] },
      { resource: 'Customer', name: 'customers', existing: ['list', 'create', 'edit'], possible: ['list', 'create', 'edit', 'show'] },
      { resource: 'Transaction', name: 'transactions', existing: ['list'], possible: ['list', 'show'] },
    ])
  })

  it('adds a resource\'s missing pages, registers them, and undo takes it all back', async () => {
    const app = read('src/App.tsx')
    const { plan: p, result } = await apply('Account')
    expect(p.label).toBe('Add create, edit, show pages for Accounts')
    expect(result.history.undoLabel).toBe('Add create, edit, show pages for Accounts')
    for (const kind of ['create', 'edit', 'show']) expect(exists(`src/pages/accounts/${kind}.tsx`)).toBe(true)
    const code = read('src/App.tsx')
    expect(code).toContain('            list: "/accounts",\n            meta: { icon: <LandmarkIcon /> },\n            create: "/accounts/create",\n            edit: "/accounts/edit/:id",\n            show: "/accounts/show/:id",\n')
    expect(code).toContain('<Route path="/accounts/create" element={<AccountCreate />} />')
    expect(code).toMatch(/<Route path="\/accounts\/show\/:id" element=\{<AccountShow \/>\} \/>\n\s+<Route path="\*"/)
    expect(code).toContain('import { AccountCreate } from "@/pages/accounts/create";')
    const create = read('src/pages/accounts/create.tsx')
    expect(create).toContain('currency: z.enum(["EUR", "USD", "GBP"]),')
    // Codes keep their case in labels (a real agent caught "Eur").
    expect(create).toContain('<SelectItem value="EUR">EUR</SelectItem>')
    expect(create).toContain('<SelectItem value="checking">Checking</SelectItem>')
    expect(create).toContain('action: "create",')
    expect(read('src/pages/accounts/show.tsx')).toContain('const { result: record } = useShow<AccountDto>({')
    typecheck()
    expect((await get(server.socket, '/refine/resources')).body.data[0].existing).toEqual(['list', 'create', 'edit', 'show'])

    await post(server.socket, '/undo')
    expect(read('src/App.tsx')).toBe(app)
    for (const kind of ['create', 'edit', 'show']) expect(exists(`src/pages/accounts/${kind}.tsx`)).toBe(false)
  }, 120_000)

  it('scaffolds a resource the app has never had, from a spec change', async () => {
    const specFile = path.join(root, 'openapi/bank.openapi.json')
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'))
    spec.components.schemas.CardStatus = { type: 'string', enum: ['active', 'blocked'] }
    spec.components.schemas.CardDto = {
      type: 'object',
      required: ['id', 'accountId', 'last4', 'status', 'expiresOn'],
      properties: {
        id: { type: 'string', format: 'uuid', readOnly: true },
        accountId: { type: 'string', format: 'uuid' },
        last4: { type: 'string' },
        status: { $ref: '#/components/schemas/CardStatus' },
        dailyLimit: { type: 'number' },
        contactless: { type: 'boolean' },
        expiresOn: { type: 'string', format: 'date' },
      },
    }
    spec.components.schemas.CreateCardRequest = {
      type: 'object',
      required: ['accountId', 'pin'],
      properties: {
        accountId: { type: 'string', format: 'uuid' },
        // Bounds of every kind, and the widgets they choose (docs/product.md, slice 5).
        pin: { type: 'string', format: 'password', minLength: 4, maxLength: 6 },
        nickname: { type: 'string', maxLength: 40, pattern: '^[A-Za-z ]+$' },
        dailyLimit: { type: 'number', exclusiveMinimum: 0, maximum: 10000 },
        contactless: { type: 'boolean' },
        memo: { type: 'string', maxLength: 2000 },
      },
    }
    spec.components.schemas.CardPage = { type: 'object', required: ['items', 'total'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/CardDto' } }, total: { type: 'integer' } } }
    const ok = (schema: string, status = '200') => ({ [status]: { description: 'OK', content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } } } })
    spec.paths['/api/v1/cards'] = {
      get: { tags: ['Cards'], operationId: 'listCards', responses: ok('CardPage') },
      post: { tags: ['Cards'], operationId: 'createCard', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateCardRequest' } } } }, responses: ok('CardDto', '201') },
    }
    spec.paths['/api/v1/cards/{id}'] = {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { tags: ['Cards'], operationId: 'getCardById', responses: ok('CardDto') },
    }
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2))
    expect((await post(server.socket, '/sync', {})).status).toBe(200)

    const { plan: p } = await apply('Card')
    expect(p.label).toBe('Add list, create, show pages for Cards')
    const code = read('src/App.tsx')
    expect(code).toContain('          {\n            name: "cards",\n            list: "/cards",\n            create: "/cards/create",\n            show: "/cards/show/:id",\n          },\n')
    const list = read('src/pages/cards/list.tsx')
    expect(list).toContain('const columns = useMemo<ColumnDef<CardDto>[]>(')
    expect(list).toContain('<ShowButton recordItemId={row.original.id} size="sm" variant="ghost" />')
    expect(list).not.toContain('EditButton')
    const create = read('src/pages/cards/create.tsx')
    expect(create).toContain('contactless: z.boolean().optional(),')
    expect(create).toContain('pin: z.string().min(4, "Enter at least 4 characters.").max(6, "Enter at most 6 characters."),')
    expect(create).toContain(
      'nickname: z.string().max(40, "Enter at most 40 characters.").regex(new RegExp("^[A-Za-z ]+$"), "Enter a value in the expected format.").optional(),',
    )
    expect(create).toContain('dailyLimit: z.number().gt(0, "Enter more than 0.").max(10000, "Enter 10000 or less.").optional(),')
    expect(create).toContain('type="password"')
    expect(create).toMatch(/<Textarea\n\s+\{\.\.\.field\}\n\s+id="card-memo"/)
    expect(create).toContain('import { Textarea } from "@/components/ui/textarea";')
    typecheck()
    // The new list is a page Trivia reads like any other.
    const page = (await get(server.socket, '/refine/page?file=src/pages/cards/list.tsx')).body.data[0]
    expect(page.columns.map((c: any) => c.key)).toEqual(['accountId', 'last4', 'status', 'dailyLimit', 'contactless', 'expiresOn', 'actions'])
  }, 120_000)

  it('refuses what it cannot add', async () => {
    const refused = async (resource: string, pages?: string[]) => {
      const reply = await plan(resource, pages)
      return `${reply.status} ${reply.body.error.code}: ${reply.body.error.message}`
    }
    expect(await refused('Nope')).toMatch(/^404 node_not_found: the contract has no resource `Nope`/)
    expect(await refused('Transaction', ['create'])).toMatch(/^422 unsupported: Transaction's contract has no operation for a create page/)
    expect(await refused('Customer', ['list'])).toMatch(/^409 conflict: customers already has a list page/)
  })
})
