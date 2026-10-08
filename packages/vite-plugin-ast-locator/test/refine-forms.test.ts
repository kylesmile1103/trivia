// The Refine adapter's form pages (docs/product.md, slice 2) on a copy of examples/refine-admin:
// each field is a zod rule, a default value and a Controller, and a plan keeps the three in step.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { REFINE_ADMIN, copyRefineAdmin, get, post, startServer, type TestServer } from './helpers.js'

const CREATE = 'src/pages/customers/create.tsx'
const EDIT = 'src/pages/customers/edit.tsx'

let root: string
let server: TestServer
const originals: Record<string, string> = {}

beforeAll(async () => {
  root = copyRefineAdmin()
  server = await startServer(root)
  for (const file of [CREATE, EDIT]) originals[file] = fs.readFileSync(path.join(root, file), 'utf8')
})

afterAll(async () => {
  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  for (const [file, text] of Object.entries(originals)) fs.writeFileSync(path.join(root, file), text)
})

const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const form = async (file: string) => {
  const reply = await get(server.socket, `/refine/page?file=${encodeURIComponent(file)}`)
  expect(reply.status, JSON.stringify(reply.body)).toBe(200)
  return (reply.body.data as any[]).find((p) => p.kind === 'form')
}
const plan = (file: string, changes: unknown[]) => post(server.socket, '/refine/fields/plan', { file, changes })
const apply = async (file: string, changes: unknown[]) => {
  const planned = await plan(file, changes)
  expect(planned.status, JSON.stringify(planned.body)).toBe(200)
  const applied = await post(server.socket, '/batch', { ops: planned.body.data.ops, label: planned.body.data.label })
  expect(applied.status, JSON.stringify(applied.body)).toBe(200)
  return applied.body.data
}
const typecheck = () => {
  try {
    execFileSync(path.join(REFINE_ADMIN, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.app.json', '--noEmit'], { cwd: root, encoding: 'utf8' })
  } catch (error) {
    throw new Error(`the generated fields do not type-check:\n${(error as { stdout?: string }).stdout}`)
  }
}

describe('form pages', () => {
  it('reads a create form: its schema, defaults and Controllers, against the create body', async () => {
    const p = await form(CREATE)
    expect(p).toMatchObject({
      component: 'CustomerCreate',
      action: 'create',
      contract: { resource: 'Customer', operation: 'create' },
      schemaPath: `${CREATE}#module#customerSchema`,
      defaultsPath: `${CREATE}#CustomerCreate#useForm().defaultValues`,
    })
    expect(p.fields.map((f: any) => [f.name, f.label, f.widget, f.rule, f.hasDefault, f.field?.shape])).toEqual([
      ['fullName', 'Full name', 'Input', 'z.string().min(2, "Enter at least 2 characters.")', true, 'text'],
      ['email', 'Email', 'Input', 'z.email("Enter an email address.")', true, 'text'],
      ['segment', 'Segment', 'Select', 'z.enum(["retail", "private", "business"])', true, 'enum'],
    ])
    expect(p.available.map((f: any) => f.name)).toEqual(['phone', 'creditLimit', 'birthDate', 'notes'])
    expect(p.available.find((f: any) => f.name === 'notes').constraints).toEqual({ maxLength: 1000 })
  })

  it('reads an edit form against the update body', async () => {
    const p = await form(EDIT)
    expect(p).toMatchObject({ action: 'edit', contract: { resource: 'Customer', operation: 'update' } })
    expect(p.fields.map((f: any) => f.name)).toEqual(['fullName', 'email', 'status', 'segment'])
    expect(p.available.map((f: any) => f.name)).toEqual(['phone', 'creditLimit', 'birthDate', 'notes'])
  })
})

describe('field plans', () => {
  it('adds a field as its rule, its default and a Controller, in one entry', async () => {
    const result = await apply(CREATE, [{ action: 'add', field: 'creditLimit' }])
    expect(result.history.undoLabel).toBe('Add field Credit limit')
    const code = read(CREATE)
    expect(code).toContain('  creditLimit: z.number().min(0, "Enter 0 or more.").optional(),\n});')
    expect(code).toContain('      creditLimit: undefined,\n    },')
    expect(code).toContain('            name="creditLimit"')
    expect(code).toContain('onChange={(e) => field.onChange(e.target.value === "" ? undefined : e.target.valueAsNumber)}')
    expect((await form(CREATE)).fields.map((f: any) => f.name)).toEqual(['fullName', 'email', 'segment', 'creditLimit'])
  })

  it('writes fields that type-check, for every kind the bodies have', async () => {
    await apply(CREATE, ['phone', 'creditLimit', 'birthDate', 'notes'].map((field) => ({ action: 'add', field })))
    await apply(EDIT, ['phone', 'creditLimit', 'birthDate', 'notes'].map((field) => ({ action: 'add', field })))
    expect(read(CREATE)).toContain('birthDate: z.iso.date("Enter a date.").nullable().optional(),')
    expect(read(CREATE)).toContain('notes: z.string().max(1000, "Enter at most 1000 characters.").nullable().optional(),')
    expect(read(EDIT)).toContain('type="date"')
    expect(read(EDIT)).toContain('<Textarea')
    typecheck()
  }, 120_000)

  it('plans several changes in order, tracking the Controllers each one moves', async () => {
    await apply(CREATE, [
      { action: 'add', field: 'birthDate', index: 0 },
      { action: 'move', field: 'segment', index: 1 },
      { action: 'remove', field: 'email' },
    ])
    const p = await form(CREATE)
    expect(p.fields.map((f: any) => f.name)).toEqual(['birthDate', 'segment', 'fullName'])
    expect(read(CREATE)).not.toContain('email')
    await post(server.socket, '/undo')
    expect(read(CREATE)).toBe(originals[CREATE])
  })

  it('refuses what it cannot plan, and says why', async () => {
    const refused = async (file: string, changes: unknown[]) => {
      const reply = await plan(file, changes)
      return `${reply.status} ${reply.body.error.code}: ${reply.body.error.message}`
    }
    expect(await refused(CREATE, [{ action: 'add', field: 'status' }])).toMatch(/^400 invalid_op: the create body of Customer has no field `status`/)
    expect(await refused(CREATE, [{ action: 'add', field: 'email' }])).toMatch(/^409 conflict: CustomerCreate already has a `email` field/)
    expect(await refused(CREATE, [{ action: 'remove', field: 'nope' }])).toMatch(/^404 node_not_found: CustomerCreate has no `nope` field/)
    expect(await refused('src/pages/customers/list.tsx', [{ action: 'remove', field: 'x' }])).toMatch(/^404 node_not_found: .* has no Refine form/)
  })
})
