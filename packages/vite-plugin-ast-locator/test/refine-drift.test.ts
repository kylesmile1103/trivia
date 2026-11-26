// Contract drift (docs/product.md, slice 3) on a copy of examples/refine-admin: change the spec,
// sync, and each page says where it is out of step, with a fix; applying the fixes leaves no
// drift and code that type-checks against the regenerated types.

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

const drift = async () => {
  const reply = await get(server.socket, '/refine/drift')
  expect(reply.status, JSON.stringify(reply.body)).toBe(200)
  return reply.body.data as { spec: any; pages: Array<{ file: string; component: string; kind: string; issues: any[] }> }
}
const fix = async (page: { file: string; component: string; kind: string }, issue: { fix: { label: string; changes: unknown[] } }) => {
  const route = page.kind === 'list' ? '/refine/columns/plan' : '/refine/fields/plan'
  const planned = await post(server.socket, route, { file: page.file, component: page.component, changes: issue.fix.changes })
  expect(planned.status, JSON.stringify(planned.body)).toBe(200)
  const applied = await post(server.socket, '/batch', { ops: planned.body.data.ops, label: issue.fix.label })
  expect(applied.status, JSON.stringify(applied.body)).toBe(200)
}

describe('contract drift', () => {
  it('is empty while the pages match the contract', async () => {
    const d = await drift()
    expect(d.spec).toMatchObject({ status: 'current' })
    expect(d.pages).toEqual([])
  })

  it('names what a spec change broke on each page, and its fixes clear it', async () => {
    const specFile = path.join(root, 'openapi/bank.openapi.json')
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'))
    const schemas = spec.components.schemas
    delete schemas.CustomerDto.properties.email
    schemas.CustomerDto.required = schemas.CustomerDto.required.filter((r: string) => r !== 'email')
    schemas.CustomerStatus.enum.push('closed')
    schemas.Nationality = { type: 'string', enum: ['GB', 'US', 'VN'] }
    schemas.CreateCustomerRequest.properties.nationality = { $ref: '#/components/schemas/Nationality' }
    schemas.CreateCustomerRequest.required.push('nationality')
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2))

    expect((await drift()).spec).toMatchObject({ status: 'changed' })
    const synced = await post(server.socket, '/sync', {})
    expect(synced.status, JSON.stringify(synced.body)).toBe(200)

    const d = await drift()
    expect(d.spec).toMatchObject({ status: 'current' })
    const summary = d.pages.map((p) => `${p.component}: ${p.issues.map((i) => `${i.code} ${i.name}`).join(', ')}`)
    expect(summary).toEqual([
      'CustomerCreate: required_missing nationality',
      'CustomerEdit: enum_changed status',
      'CustomerList: missing_field email, enum_changed status',
    ])
    const list = d.pages.find((p) => p.component === 'CustomerList')!
    expect(list.issues[0]).toMatchObject({
      message: 'Column Email shows `email`, which the contract no longer has',
      fix: { label: 'Remove column Email', changes: [{ action: 'remove', column: 'email' }] },
    })
    expect(list.issues[1].message).toBe('Column Status filters on pending, active, suspended; the contract\'s values are pending, active, suspended, closed')
    expect(list.issues[1].fix.changes).toEqual([{ action: 'align', column: 'status' }])

    // A fix read before another fix ran still lands right: a change is resolved when it is
    // planned, by the column's key (the designer's list may lag behind the source).
    await fix(list, list.issues[0])
    await fix(list, list.issues[1])
    const listPage = (await get(server.socket, '/refine/page?file=src/pages/customers/list.tsx')).body.data[0]
    expect(listPage.columns.map((c: any) => c.key)).toEqual(['fullName', 'status', 'createdAt', 'actions'])

    // Fix the rest one issue at a time, re-reading the drift in between.
    for (let guard = 0; guard < 10; guard += 1) {
      const pages = (await drift()).pages
      const page = pages[0]
      if (!page) break
      await fix(page, page.issues[0])
    }
    expect((await drift()).pages).toEqual([])
    const listCode = fs.readFileSync(path.join(root, 'src/pages/customers/list.tsx'), 'utf8')
    expect(listCode).not.toContain('accessorKey: "email"')
    expect(listCode).toContain('{ label: "Closed", value: "closed" },')
    expect(fs.readFileSync(path.join(root, 'src/pages/customers/create.tsx'), 'utf8')).toContain('nationality: z.enum(["GB", "US", "VN"]),')
    try {
      execFileSync(path.join(REFINE_ADMIN, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.app.json', '--noEmit'], { cwd: root, encoding: 'utf8' })
    } catch (error) {
      throw new Error(`the fixed pages do not type-check:\n${(error as { stdout?: string }).stdout}`)
    }
  }, 120_000)
})
