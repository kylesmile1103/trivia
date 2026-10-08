// The Refine adapter (docs/product.md, slice 1) on a copy of examples/refine-admin: list pages,
// their columns and contract fields, and column plans applied through the edit API.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { REFINE_ADMIN, copyRefineAdmin, get, post, socketFetch, startServer, type TestServer } from './helpers.js'

const CUSTOMERS = 'src/pages/customers/list.tsx'

let root: string
let server: TestServer
let original: string

beforeAll(async () => {
  root = copyRefineAdmin()
  server = await startServer(root)
  original = fs.readFileSync(path.join(root, CUSTOMERS), 'utf8')
})

afterAll(async () => {
  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(async () => {
  // Each test starts from the original page, with nothing to undo into.
  fs.writeFileSync(path.join(root, CUSTOMERS), original)
})

const read = () => fs.readFileSync(path.join(root, CUSTOMERS), 'utf8')
const page = async (file = CUSTOMERS) => {
  const reply = await get(server.socket, `/refine/page?file=${encodeURIComponent(file)}`)
  expect(reply.status, JSON.stringify(reply.body)).toBe(200)
  return reply.body.data[0]
}
const plan = async (changes: unknown[], file = CUSTOMERS) => post(server.socket, '/refine/columns/plan', { file, changes })
const apply = async (changes: unknown[]) => {
  const planned = await plan(changes)
  expect(planned.status, JSON.stringify(planned.body)).toBe(200)
  const applied = await post(server.socket, '/batch', { ops: planned.body.data.ops, label: planned.body.data.label })
  expect(applied.status, JSON.stringify(applied.body)).toBe(200)
  return applied.body.data
}

describe('list pages', () => {
  it('finds every page that calls useTable, and the contract resource it shows', async () => {
    const reply = await get(server.socket, '/refine/pages')
    const pages = reply.body.data as Array<Record<string, any>>
    expect(pages.filter((p) => p.kind === 'list').map((p) => [p.file, p.component, p.resource, p.contract?.resource])).toEqual([
      ['src/pages/accounts/list.tsx', 'AccountList', { name: 'accounts', from: 'refineCoreProps' }, 'Account'],
      ['src/pages/customers/list.tsx', 'CustomerList', { name: 'customers', from: 'refineCoreProps' }, 'Customer'],
      // No resource prop: the row type names the contract resource.
      ['src/pages/transactions/list.tsx', 'TransactionList', { name: 'transactions', from: 'typeArgument' }, 'Transaction'],
    ])
  })

  it('reads the columns as the source has them, and the fields not shown yet', async () => {
    const p = await page()
    expect(p.columnsPath).toBe(`${CUSTOMERS}#CustomerList#columns`)
    expect(p.rowType).toBe('CustomerDto')
    expect(p.columns.map((c: any) => [c.key, c.label, c.filter, c.sortable, c.hasCell, c.field?.shape])).toEqual([
      ['fullName', 'Name', 'DataTableFilterDropdownText', true, false, 'text'],
      ['email', 'Email', null, false, false, 'text'],
      ['status', 'Status', 'DataTableFilterCombobox', true, true, 'enum'],
      ['createdAt', 'Customer since', null, true, true, 'dateTime'],
      // Row actions: no label, no field.
      ['actions', null, null, false, true, undefined],
    ])
    expect(p.columns[2].path).toBe(`${CUSTOMERS}#CustomerList#columns[id=status]`)
    expect(p.available.map((f: any) => f.name)).toEqual(['id', 'phone', 'kycStatus', 'segment', 'creditLimit', 'birthDate', 'notes'])
    expect(p.available.find((f: any) => f.name === 'kycStatus')).toMatchObject({ shape: 'enum', enum: ['not_started', 'in_review', 'approved', 'rejected'] })
  })
})

describe('column plans', () => {
  it('adds a contract field as a typed column, touching nothing else', async () => {
    const result = await apply([{ action: 'add', field: 'kycStatus', index: 3 }])
    expect(result.history.undoLabel).toBe('Add column KYC status')
    const code = read()
    const start = original.indexOf('      {\n        id: "createdAt"')
    const added = code.slice(start, code.length - (original.length - start))
    // Byte-preserving: the page is the original with one column spliced in, plus its import.
    expect(code.slice(code.length - (original.length - start))).toBe(original.slice(start))
    expect(added).toContain('id: "kycStatus"')
    expect(added).toContain('<DataTableFilterCombobox')
    expect(added).toContain('{ label: "Not started", value: "not_started" },')
    expect(added).toContain('<Badge variant="secondary">{getValue<string>()}</Badge>')
    expect(added).toContain('<DataTableSorter column={column} />')
    expect(added).not.toContain('enableSorting: false')
    expect(added).toMatch(/^      \{\n        id: "kycStatus",\n        accessorKey: "kycStatus",\n        header: \(\{ column \}\) => \(\n/)
    expect((await page()).columns.map((c: any) => c.key)).toEqual(['fullName', 'email', 'status', 'kycStatus', 'createdAt', 'actions'])
  })

  it('writes columns that type-check, for every kind of field', async () => {
    await apply(['id', 'phone', 'segment', 'creditLimit', 'birthDate', 'kycStatus'].map((field) => ({ action: 'add', field })))
    const added = (await page()).columns.map((c: any) => c.key)
    // Without an index, each goes after the last data column, before the row actions.
    expect(added).toEqual(['fullName', 'email', 'status', 'createdAt', 'id', 'phone', 'segment', 'creditLimit', 'birthDate', 'kycStatus', 'actions'])
    const code = read()
    expect(code).toContain('<DataTableFilterDropdownNumeric')
    expect(code).toContain('<DataTableFilterDropdownDateRangePicker column={column} />')
    expect(code).toMatch(/import \{\s*DataTableFilterCombobox,\s*DataTableFilterDropdownDateRangePicker,\s*DataTableFilterDropdownNumeric,\s*DataTableFilterDropdownText,\s*\} from "@\/components\/refine-ui\/data-table\/data-table-filter";/)
    const tsc = path.join(REFINE_ADMIN, 'node_modules/.bin/tsc')
    try {
      execFileSync(tsc, ['-p', 'tsconfig.app.json', '--noEmit'], { cwd: root, encoding: 'utf8' })
    } catch (error) {
      throw new Error(`the generated columns do not type-check:\n${(error as { stdout?: string }).stdout}`)
    }
  }, 120_000)

  it('moves and removes columns by key, and undo restores the bytes', async () => {
    await apply([{ action: 'move', column: 'status', index: 0 }])
    expect((await page()).columns.map((c: any) => c.key)).toEqual(['status', 'fullName', 'email', 'createdAt', 'actions'])
    await apply([{ action: 'remove', column: 'email' }])
    expect((await page()).columns.map((c: any) => c.key)).toEqual(['status', 'fullName', 'createdAt', 'actions'])
    await post(server.socket, '/undo')
    await post(server.socket, '/undo')
    expect(read()).toBe(original)
  })

  it('refuses what it cannot plan, and says why', async () => {
    const refused = async (changes: unknown[], file?: string) => {
      const reply = await plan(changes, file)
      return `${reply.status} ${reply.body.error.code}: ${reply.body.error.message}`
    }
    expect(await refused([{ action: 'add', field: 'nope' }])).toMatch(/^400 invalid_op: Customer has no field `nope` \(it has id, fullName/)
    expect(await refused([{ action: 'add', field: 'email' }])).toMatch(/^409 conflict: CustomerList already shows `email`/)
    expect(await refused([{ action: 'remove', column: 'nope' }])).toMatch(/^404 node_not_found: CustomerList has no column `nope` \(it has fullName, email, status, createdAt, actions\)/)
    expect(await refused([{ action: 'explode' }])).toMatch(/^400 invalid_op: changes must be/)
    expect(await refused([{ action: 'remove', column: 'x' }], 'src/App.tsx')).toMatch(/^404 node_not_found: src\/App.tsx has no Refine list page/)
  })
})

describe('MCP', () => {
  type ToolResult = { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: any }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const client = new Client({ name: 'refine-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/@trivia/mcp'), { fetch: socketFetch(server.socket) }) as unknown as Transport)
    try {
      return (await client.callTool({ name, arguments: args })) as ToolResult
    } finally {
      await client.close()
    }
  }

  it('trivia_get_page reads the selected element\'s page, else every page', async () => {
    await post(server.socket, '/selection', { locator: null })
    const all = await call('trivia_get_page')
    expect(all.structuredContent.pages.map((p: any) => `${p.kind} ${p.component}`)).toEqual([
      'list AccountList',
      'form CustomerCreate',
      'form CustomerEdit',
      'list CustomerList',
      'list TransactionList',
    ])
    const outline = await get(server.socket, `/outline?file=${encodeURIComponent(CUSTOMERS)}`)
    const listView = outline.body.data.at(-1)
    await post(server.socket, '/selection', { locator: listView.locator, name: listView.name })
    const one = await call('trivia_get_page')
    expect(one.structuredContent.file).toBe(CUSTOMERS)
    expect(one.structuredContent.pages[0].available.map((f: any) => f.name)).toContain('kycStatus')
    const forms = await call('trivia_get_page', { file: 'src/pages/customers/create.tsx' })
    expect(forms.structuredContent.pages[0].fields.map((f: any) => f.name)).toEqual(['fullName', 'email', 'segment'])
    const none = await call('trivia_get_page', { file: 'src/App.tsx' })
    expect(none.structuredContent.hint).toContain('has no Refine list page')
    await post(server.socket, '/selection', { locator: null })
  })

  it('trivia_edit_columns adds, moves and removes in one undo entry', async () => {
    const r = await call('trivia_edit_columns', {
      file: CUSTOMERS,
      changes: [{ action: 'add', field: 'kycStatus' }, { action: 'move', column: 'kycStatus', index: 1 }, { action: 'remove', column: 'email' }],
      label: 'Show KYC status',
    })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    expect(r.structuredContent.page.columns.map((c: any) => c.key)).toEqual(['fullName', 'kycStatus', 'status', 'createdAt', 'actions'])
    expect(r.structuredContent.history.undoLabel).toBe('Agent: Show KYC status')
    await post(server.socket, '/undo')
    expect(read()).toBe(original)
  })

  it('trivia_apply takes value ops', async () => {
    const r = await call('trivia_apply', {
      ops: [{ op: 'setProperty', path: `${CUSTOMERS}#CustomerList#columns[id=email]`, prop: 'header', value: '"E-mail"' }],
      label: 'Rename Email',
    })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    expect(read()).toContain('header: "E-mail",')
    const refused = await call('trivia_edit_columns', { file: CUSTOMERS, changes: [{ action: 'add', field: 'nope' }], label: 'x' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/^invalid_op: Customer has no field `nope`/)
  })
})

describe('MCP fields', () => {
  it('trivia_edit_fields adds a field to a form in one undo entry', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const client = new Client({ name: 'refine-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/@trivia/mcp'), { fetch: socketFetch(server.socket) }) as unknown as Transport)
    const file = 'src/pages/customers/create.tsx'
    const before = fs.readFileSync(path.join(root, file), 'utf8')
    try {
      const r = (await client.callTool({
        name: 'trivia_edit_fields',
        arguments: { file, changes: [{ action: 'add', field: 'phone', index: 2 }], label: 'Ask for a phone number' },
      })) as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: any }
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
      expect(r.structuredContent.page.fields.map((f: any) => f.name)).toEqual(['fullName', 'email', 'phone', 'segment'])
      expect(r.structuredContent.history.undoLabel).toBe('Agent: Ask for a phone number')
    } finally {
      await client.close()
      await post(server.socket, '/undo')
    }
    expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe(before)
  })
})

