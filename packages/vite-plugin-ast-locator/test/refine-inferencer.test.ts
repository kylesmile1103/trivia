// The inferencer's side of the plugin (docs/product.md, slice 6) on a copy of
// examples/refine-admin: pages generated from the contract alone, served as modules Vite
// compiles, and ejected to disk where the inferencer was, as one undo entry.

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
const preview = async (body: Record<string, unknown>) => {
  const reply = await post(server.socket, '/refine/preview', body)
  expect(reply.status, JSON.stringify(reply.body)).toBe(200)
  return reply.body.data
}
const refused = async (route: string, body: Record<string, unknown>) => {
  const reply = await post(server.socket, route, body)
  return `${reply.status} ${reply.body.error.code}: ${reply.body.error.message}`
}
const typecheck = () => {
  try {
    execFileSync(path.join(REFINE_ADMIN, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.app.json', '--noEmit'], { cwd: root, encoding: 'utf8' })
  } catch (error) {
    throw new Error(`the ejected pages do not type-check:\n${(error as { stdout?: string }).stdout}`)
  }
}

describe('inferred pages', () => {
  it('generates every kind from the contract alone: no record, no request to the API', async () => {
    // The test server runs no mock API at all: the pages come from trivia.manifest.json.
    const pages = await Promise.all(['list', 'create', 'edit', 'show'].map((kind) => preview({ resource: 'customers', kind })))
    expect(pages.map((p: any) => [p.resource, p.name, p.kind, p.component, p.file, p.exists, p.route])).toEqual([
      ['Customer', 'customers', 'list', 'CustomerList', 'src/pages/customers/list.tsx', true, '/customers'],
      ['Customer', 'customers', 'create', 'CustomerCreate', 'src/pages/customers/create.tsx', true, '/customers/create'],
      ['Customer', 'customers', 'edit', 'CustomerEdit', 'src/pages/customers/edit.tsx', true, '/customers/edit/:id'],
      ['Customer', 'customers', 'show', 'CustomerShow', 'src/pages/customers/show.tsx', false, '/customers/show/:id'],
    ])
    expect(pages.every((p: any) => /^\/@trivia\/preview\/[0-9a-f]{16}\.tsx$/.test(p.module))).toBe(true)
    // Every column and input the contract has, with no row to guess them from.
    const [list, create] = pages
    expect([...list.code.matchAll(/accessorKey: "(\w+)"/g)].map((m) => m[1])).toEqual(['fullName', 'email', 'phone', 'status', 'kycStatus', 'segment'])
    expect([...create.code.matchAll(/name="(\w+)"/g)].map((m) => m[1])).toEqual(['fullName', 'email', 'phone', 'segment', 'creditLimit', 'birthDate', 'notes'])
    // The contract's name works as well as Refine's.
    expect((await preview({ resource: 'Customer', kind: 'show' })).module).toBe(pages[3].module)
  })

  it('serves a preview as a module Vite compiles with the project\'s aliases, unstamped', async () => {
    const page = await preview({ resource: 'transactions', kind: 'show' })
    const out = await server.vite.transformRequest(page.module)
    expect(out?.code).toContain('/src/components/refine-ui/views/show-view.tsx')
    expect(out?.code).toContain('export function TransactionShow')
    // Its elements belong to no file yet, so they carry no locators to select.
    expect(out?.code).not.toContain('data-ast-node')
    // Tailwind finds classes in files on disk: the preview brings a stylesheet for its own,
    // built against the app's Tailwind entry (its theme).
    const styles = page.module.replace(/\.tsx$/, '.css')
    const id = path.basename(styles)
    // Vite writes the import as the stylesheet's URL from the root; the browser asks for that.
    expect(out?.code).toContain(`import "/src/.trivia-preview/${id}";`)
    const resolved = await server.vite.pluginContainer.resolveId(`/src/.trivia-preview/${id}`)
    // Vite works with the real path of the root (macOS's /var is /private/var).
    const real = fs.realpathSync(root)
    expect(resolved?.id).toBe(path.join(real, 'src/.trivia-preview', id))
    const css = await server.vite.pluginContainer.load(resolved!.id)
    const text = typeof css === 'string' ? css : (css as { code: string }).code
    expect(text).toContain(`@reference "${path.join(real, 'src/index.css')}";`)
    expect(text).toContain('@import "tailwindcss/utilities.css" layer(utilities) source(none);')
    expect(text).toMatch(/@source inline\("[^"]*grid-cols-\[max-content_1fr\][^"]*"\);/)
    const unknown = await server.vite.transformRequest('/@trivia/preview/0000000000000000.tsx')
    expect(unknown?.code).toContain('the dev server restarted since it was asked for')
  })

  it('leaves out hidden fields and takes a title', async () => {
    const page = await preview({ resource: 'customers', kind: 'list', hide: ['phone', 'email'], title: 'Clients "VIP"' })
    expect(page.code).toContain('<ListViewHeader title={"Clients \\"VIP\\""} />')
    expect(page.code).not.toMatch(/accessorKey: "(phone|email)"/)
    expect([...page.code.matchAll(/accessorKey: "(\w+)"/g)].map((m: RegExpMatchArray) => m[1])).toEqual(['fullName', 'status', 'kycStatus', 'segment', 'creditLimit', 'birthDate'])
  })

  it('refuses what it cannot preview or eject, and says why', async () => {
    expect(await refused('/refine/preview', { resource: 'cards', kind: 'list' })).toMatch(/^404 node_not_found: the contract has no resource `cards` \(it has Account \(accounts\), Customer \(customers\)/)
    expect(await refused('/refine/preview', { resource: 'transactions', kind: 'create' })).toBe('422 unsupported: Transaction\'s contract has no operation for a create page')
    expect(await refused('/refine/preview', { resource: 'customers', kind: 'grid' })).toMatch(/^400 invalid_op: body must be/)
    expect(await refused('/refine/eject', { resource: 'customers', kind: 'list' })).toMatch(/^409 conflict: src\/pages\/customers\/list.tsx already exists/)
    expect(await refused('/refine/eject', { resource: 'customers', kind: 'show', file: '../outside.tsx' })).toMatch(/^400 invalid_op: ejectPath must be a .tsx file under src\//)
  })
})

describe('eject', () => {
  it('writes the page and puts its component where the inferencer was, as one undo entry', async () => {
    // The example renders Transactions' show route with the inferencer.
    const app = read('src/App.tsx')
    expect(app).toContain('<Route path="/transactions/show/:id" element={<OpenApiShowInferencer />} />')
    const outline = (await get(server.socket, '/outline?file=src/App.tsx')).body.data
    const find = (nodes: any[]): any => nodes.flatMap((n) => (n.name === 'OpenApiShowInferencer' ? [n] : [find(n.children)].filter(Boolean)))[0]
    const locator = find(outline).locator

    const planned = await post(server.socket, '/refine/eject', { resource: 'transactions', kind: 'show', locator })
    expect(planned.status, JSON.stringify(planned.body)).toBe(200)
    expect(planned.body.data.label).toBe('Eject TransactionShow to src/pages/transactions/show.tsx')
    expect(planned.body.data.ops.map((o: any) => o.op)).toEqual(['createFile', 'replaceElement'])
    const applied = await post(server.socket, '/batch', { ops: planned.body.data.ops, label: planned.body.data.label })
    expect(applied.status, JSON.stringify(applied.body)).toBe(200)

    const after = read('src/App.tsx')
    expect(after).toContain('<Route path="/transactions/show/:id" element={<TransactionShow />} />')
    expect(after).toContain('import { TransactionShow } from "@/pages/transactions/show";')
    // Its last use gone, the inferencer's import goes too (rule 9).
    expect(after).not.toContain('OpenApiShowInferencer')
    expect(after).not.toContain('@trivia/openapi-inferencer')
    expect(read('src/pages/transactions/show.tsx')).toBe((await preview({ resource: 'transactions', kind: 'show' })).code)
    typecheck()

    await post(server.socket, '/undo')
    expect(read('src/App.tsx')).toBe(app)
    expect(fs.existsSync(path.join(root, 'src/pages/transactions/show.tsx'))).toBe(false)
  }, 120_000)

  it('writes the spec\'s form fixture in the project\'s FormField style, with bounds, an enum and a password input', async () => {
    // Two FormField forms against one Field form: the project's style is FormField.
    fs.writeFileSync(path.join(root, 'src/pages/customers/quick-edit.tsx'), read('src/pages/customers/edit.tsx').replace('export function CustomerEdit()', 'export function CustomerQuickEdit()'))
    const specFile = path.join(root, 'openapi/bank.openapi.json')
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'))
    spec.components.schemas.MemberDto = {
      type: 'object',
      required: ['id', 'nickname', 'status'],
      properties: { id: { type: 'string', format: 'uuid', readOnly: true }, nickname: { type: 'string' }, status: { type: 'string', enum: ['Active', 'Suspended'] } },
    }
    spec.components.schemas.CreateMemberRequest = {
      type: 'object',
      required: ['nickname', 'status', 'password'],
      properties: {
        nickname: { type: 'string', minLength: 5 },
        status: { type: 'string', enum: ['Active', 'Suspended'] },
        password: { type: 'string', format: 'password' },
      },
    }
    const ok = (schema: string, status = '200') => ({ [status]: { description: 'OK', content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } } } })
    spec.paths['/api/v1/members'] = {
      post: { tags: ['Members'], operationId: 'createMember', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateMemberRequest' } } } }, responses: ok('MemberDto', '201') },
    }
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2))
    expect((await post(server.socket, '/sync', {})).status).toBe(200)

    const page = await preview({ resource: 'members', kind: 'create' })
    expect(page.code).toContain('} from "@/components/ui/form";')
    expect(page.code).toContain('<FormField\n')
    expect(page.code).toContain('nickname: z.string().min(5, "Enter at least 5 characters."),')
    expect(page.code).toContain('status: z.enum(["Active", "Suspended"]),')
    expect(page.code).toMatch(/<Input\n\s+\{\.\.\.field\}\n\s+type="password"/)

    // Without the inferencer's locator, the page is still written, and the reply says what to swap.
    const planned = await post(server.socket, '/refine/eject', { resource: 'members', kind: 'create' })
    expect(planned.body.data.warnings).toEqual([
      'Trivia doesn\'t know where the inferencer is rendered: replace it with <MemberCreate /> (import { MemberCreate } from "@/pages/members/create")',
    ])
    expect((await post(server.socket, '/batch', { ops: planned.body.data.ops, label: planned.body.data.label })).status).toBe(200)
    typecheck()
  }, 120_000)
})
