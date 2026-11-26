// A contract enum that changed, fixed in place (docs/product.md, slice 3) on a copy of
// examples/refine-admin the tests customise: the fix adds and removes single options where the
// page writes them (the column's filter options, the rule's `z.enum([…])`, the Select's items)
// and leaves everything else as written.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { REFINE_ADMIN, copyRefineAdmin, get, post, socketFetch, startServer, type TestServer } from './helpers.js'

const LIST = 'src/pages/customers/list.tsx'
const EDIT = 'src/pages/customers/edit.tsx'
const SPEC = 'openapi/bank.openapi.json'

let root: string
let server: TestServer
const originals = new Map<string, string>()

const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const write = (file: string, content: string) => fs.writeFileSync(path.join(root, file), content)
/** `text` with `from` replaced by `to`, where `from` must be there exactly once. */
const swap = (text: string, from: string, to: string) => {
  expect(text.split(from).length - 1, `once in the page: ${from}`).toBe(1)
  return text.replace(from, to)
}

beforeAll(async () => {
  root = copyRefineAdmin()
  server = await startServer(root)
  for (const file of [LIST, EDIT, SPEC]) originals.set(file, read(file))
})

afterAll(async () => {
  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  for (const [file, content] of originals) write(file, content)
})

/** Write the spec with CustomerStatus's values (the list's status and the update body's), and sync. */
async function statuses(values: string[], more: (schemas: any) => void = () => {}) {
  const spec = JSON.parse(originals.get(SPEC)!)
  spec.components.schemas.CustomerStatus.enum = values
  more(spec.components.schemas)
  write(SPEC, JSON.stringify(spec, null, 2))
  const synced = await post(server.socket, '/sync', {})
  expect(synced.status, JSON.stringify(synced.body)).toBe(200)
}

const drift = async () => {
  const reply = await get(server.socket, '/refine/drift')
  expect(reply.status, JSON.stringify(reply.body)).toBe(200)
  return reply.body.data.pages as Array<{ file: string; component: string; kind: string; issues: any[] }>
}
const issueOf = async (component: string, name: string) => (await drift()).find((p) => p.component === component)?.issues.find((i) => i.name === name)
const plan = (file: string, changes: unknown[]) => post(server.socket, file === LIST ? '/refine/columns/plan' : '/refine/fields/plan', { file, changes })
/** Plan `changes` and apply them as one entry; the plan. */
async function fix(file: string, changes: unknown[], label = 'fix') {
  const planned = await plan(file, changes)
  expect(planned.status, JSON.stringify(planned.body)).toBe(200)
  const applied = await post(server.socket, '/batch', { ops: planned.body.data.ops, label })
  expect(applied.status, JSON.stringify(applied.body)).toBe(200)
  return planned.body.data as { ops: any[]; label: string; warnings?: string[] }
}
const typecheck = () => {
  try {
    execFileSync(path.join(REFINE_ADMIN, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.app.json', '--noEmit'], { cwd: root, encoding: 'utf8' })
  } catch (error) {
    throw new Error(`the fixed pages do not type-check:\n${(error as { stdout?: string }).stdout}`)
  }
}

const ROW = '                '
const option = (label: string, value: string) => `${ROW}{ label: "${label}", value: "${value}" },`
const ITEM = '                      '
const item = (value: string, label: string) => `${ITEM}<SelectItem value="${value}">${label}</SelectItem>`
/** The edit form's Status rule with these values. */
const ruleOf = (values: string) => `status: z.enum([${values}]),`
const RULE = ruleOf('"pending", "active", "suspended"')

describe('a column whose enum gained a value', () => {
  it('gets the one option added, and keeps its sorting, cell and labels', async () => {
    let list = swap(originals.get(LIST)!, option('Pending', 'pending'), option('Pending review', 'pending'))
    list = swap(
      list,
      '        cell: ({ getValue }) => (\n          <Badge variant="secondary">{getValue<string>()}</Badge>',
      '        enableSorting: false,\n        cell: ({ getValue }) => (\n          <Badge variant="secondary" className="capitalize">{getValue<string>()}</Badge>',
    )
    write(LIST, list)
    await statuses(['pending', 'active', 'suspended', 'closed'])

    const issue = await issueOf('CustomerList', 'status')
    expect(issue).toMatchObject({
      code: 'enum_changed',
      message: "Column Status filters on pending, active, suspended; the contract's values are pending, active, suspended, closed",
      fix: { label: 'Update the Status filter options from the contract', changes: [{ action: 'align', column: 'status' }] },
    })
    expect(issue.references).toBeUndefined()
    const planned = await fix(LIST, issue.fix.changes, issue.fix.label)
    expect(planned.label).toBe('Update the Status filter options from the contract')
    expect(planned.warnings).toBeUndefined()
    // One line added after Suspended, and nothing else: the label, the sorting and the cell stay.
    expect(read(LIST)).toBe(swap(list, option('Suspended', 'suspended'), `${option('Suspended', 'suspended')}\n${option('Closed', 'closed')}`))
    expect((await issueOf('CustomerList', 'status'))).toBeUndefined()
    typecheck()
    const undone = await post(server.socket, '/undo')
    expect(undone.status, JSON.stringify(undone.body)).toBe(200)
    expect(read(LIST)).toBe(list)
  }, 120_000)

  it('is aligned by an agent too, with trivia_edit_columns', async () => {
    await statuses(['pending', 'active', 'suspended', 'closed'])
    const client = new Client({ name: 'refine-enum-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/@trivia/mcp'), { fetch: socketFetch(server.socket) }) as unknown as Transport)
    try {
      const r = (await client.callTool({
        name: 'trivia_edit_columns',
        arguments: { file: LIST, changes: [{ action: 'align', column: 'status' }], label: 'Offer the closed status' },
      })) as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: any }
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
      expect(r.content[0]?.text).toContain('Update the Status filter options from the contract')
      expect(r.structuredContent.history.undoLabel).toBe('Agent: Offer the closed status')
    } finally {
      await client.close()
    }
    expect(read(LIST)).toContain(`${option('Suspended', 'suspended')}\n${option('Closed', 'closed')}`)
    await post(server.socket, '/undo')
    expect(read(LIST)).toBe(originals.get(LIST))
  }, 60_000)
})

describe('a form field whose enum changed', () => {
  it('gets the value swapped in the rule and the Select, and names the code that still uses the old one', async () => {
    let edit = swap(originals.get(EDIT)!, item('pending', 'Pending'), item('pending', 'Pending review'))
    edit = swap(edit, RULE, 'status: z.enum(["pending", "active", "suspended"], "Pick a status"),')
    write(EDIT, edit)
    await statuses(['pending', 'active', 'closed'])

    const issue = await issueOf('CustomerEdit', 'status')
    const refine = { line: 37, text: '.refine((values) => !(values.status === "suspended" && values.segment === "private"), {' }
    expect(issue).toMatchObject({
      code: 'enum_changed',
      message: 'Field Status offers pending, active, suspended; the contract\'s values are pending, active, closed; the file still names "suspended" on line 37',
      fix: { label: 'Update the Status options from the contract', changes: [{ action: 'align', field: 'status' }] },
      references: [refine],
    })
    const planned = await fix(EDIT, issue.fix.changes, issue.fix.label)
    expect(planned.label).toBe('Update the Status options from the contract')
    expect(planned.warnings).toEqual([`${EDIT} still names "suspended" outside the Status options: line 37 (${refine.text})`])
    // The rule's array and the Suspended item, and nothing else: its message, the item's label,
    // the default and the `.refine` stay as written.
    let expected = swap(edit, '["pending", "active", "suspended"], "Pick a status"', '["pending", "active", "closed"], "Pick a status"')
    expected = swap(expected, item('suspended', 'Suspended'), item('closed', 'Closed'))
    expect(read(EDIT)).toBe(expected)
    expect(await issueOf('CustomerEdit', 'status')).toBeUndefined()
    // Again: nothing left to do.
    const again = await plan(EDIT, issue.fix.changes)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('conflict')

    await post(server.socket, '/undo')
    expect(read(EDIT)).toBe(edit)
  }, 60_000)

  it('rewrites a default that names a removed value, and does not count it as a leftover', async () => {
    const edit = swap(originals.get(EDIT)!, '      status: "pending",', '      status: "suspended",')
    write(EDIT, edit)
    await statuses(['pending', 'active', 'closed'])
    const issue = await issueOf('CustomerEdit', 'status')
    expect(issue.references.map((r: any) => r.line)).toEqual([37])
    await fix(EDIT, issue.fix.changes)
    // What formFieldFor gives the field: the update body's `status` is optional.
    expect(read(EDIT)).toContain('    defaultValues: {\n      fullName: "",\n      email: "",\n      status: undefined,\n      segment: "retail",\n    },')
    expect(read(EDIT)).toContain('status: z.enum(["pending", "active", "closed"]),')
  }, 60_000)

  it('finds the Select where an earlier change in the same plan moved it', async () => {
    await statuses(['pending', 'active', 'suspended', 'closed'])
    // A field added first shifts the grid that holds Status, and the items with it.
    const planned = await fix(EDIT, [{ action: 'add', field: 'phone', index: 0 }, { action: 'align', field: 'status' }])
    expect(planned.label).toBe('Add field Phone; Update the Status options from the contract')
    const code = read(EDIT)
    expect(code).toContain('name="phone"')
    expect(code).toContain('status: z.enum(["pending", "active", "suspended", "closed"]),')
    expect(code).toContain(`${item('suspended', 'Suspended')}\n${item('closed', 'Closed')}\n${ITEM.slice(2)}</SelectContent>`)
    expect(code.match(/<SelectItem value="closed">/g)).toHaveLength(1)
    await post(server.socket, '/undo')
    expect(read(EDIT)).toBe(originals.get(EDIT))
  }, 60_000)

  it('rejects an align after another change to the same field in one plan', async () => {
    await statuses(['pending', 'active', 'closed'])
    const refused = await plan(EDIT, [{ action: 'rebuild', field: 'status' }, { action: 'align', field: 'status' }])
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toContain('changed earlier in this plan')
  }, 60_000)
})

describe('the order a page chose', () => {
  it('stays: a new value goes after the nearest one before it in the contract, at every site', async () => {
    const list = swap(originals.get(LIST)!, `${option('Pending', 'pending')}\n${option('Active', 'active')}\n${option('Suspended', 'suspended')}`,
      `${option('Suspended', 'suspended')}\n${option('Pending', 'pending')}\n${option('Active', 'active')}`)
    let edit = swap(originals.get(EDIT)!, ruleOf('"pending", "active", "suspended"'), ruleOf('"suspended", "pending", "active"'))
    edit = swap(edit, `${item('pending', 'Pending')}\n${item('active', 'Active')}\n${item('suspended', 'Suspended')}`,
      `${item('suspended', 'Suspended')}\n${item('pending', 'Pending')}\n${item('active', 'Active')}`)
    write(LIST, list)
    write(EDIT, edit)
    await statuses(['pending', 'active', 'review', 'suspended'])

    await fix(LIST, [{ action: 'align', column: 'status' }])
    await fix(EDIT, [{ action: 'align', field: 'status' }])
    expect(read(LIST)).toBe(swap(list, option('Active', 'active'), `${option('Active', 'active')}\n${option('Review', 'review')}`))
    expect(read(EDIT)).toBe(
      swap(swap(edit, ruleOf('"suspended", "pending", "active"'), ruleOf('"suspended", "pending", "active", "review"')), item('active', 'Active'), `${item('active', 'Active')}\n${item('review', 'Review')}`),
    )
    expect(await drift()).toEqual([])
    typecheck()
  }, 120_000)
})

describe('a value added, then dropped again', () => {
  it('leaves the pages as they were', async () => {
    await statuses(['pending', 'active', 'suspended', 'closed'])
    await fix(LIST, [{ action: 'align', column: 'status' }])
    await fix(EDIT, [{ action: 'align', field: 'status' }])
    expect(read(LIST)).not.toBe(originals.get(LIST))
    expect(read(EDIT)).toContain('<SelectItem value="closed">Closed</SelectItem>')

    await statuses(['pending', 'active', 'suspended'])
    for (const page of await drift()) {
      for (const issue of page.issues) await fix(page.file, issue.fix.changes, issue.fix.label)
    }
    expect(read(LIST)).toBe(originals.get(LIST))
    expect(read(EDIT)).toBe(originals.get(EDIT))
  }, 120_000)
})

describe('shapes an in-place fix reads, and shapes it leaves alone', () => {
  const STATUSES = 'const STATUSES = ["pending", "active", "suspended"] as const;\n\n'
  const constantRule = () =>
    swap(swap(originals.get(EDIT)!, RULE, 'status: z.enum(STATUSES),'), '// Status and segment', `${STATUSES}// Status and segment`)

  it('has no verdict on a rule that is a constant, and aligns the literal items next to it', async () => {
    const edit = constantRule()
    write(EDIT, edit)
    await statuses(['pending', 'active', 'suspended'])
    // The items match, and the constant is not read: no drift (it used to be a false positive).
    expect(await drift()).toEqual([])

    await statuses(['pending', 'active', 'suspended', 'closed'])
    const issue = await issueOf('CustomerEdit', 'status')
    expect(issue).toMatchObject({ code: 'enum_changed', fix: { changes: [{ action: 'align', field: 'status' }] } })
    expect(issue.message).toMatch(/^Field Status offers pending, active, suspended; the contract's values are pending, active, suspended, closed$/)
    const planned = await fix(EDIT, issue.fix.changes)
    expect(planned.ops.map((o) => o.op)).toEqual(['insert'])
    expect(planned.warnings).toEqual([`${EDIT}: the Status rule \`z.enum(STATUSES)\` is not a literal list, so it was left as written`])
    expect(read(EDIT)).toBe(swap(edit, item('suspended', 'Suspended'), `${item('suspended', 'Suspended')}\n${item('closed', 'Closed')}`))
  }, 60_000)

  it('has no verdict on options that are a constant, and refuses to align them', async () => {
    const list = swap(
      swap(originals.get(LIST)!, `options={[\n${option('Pending', 'pending')}\n${option('Active', 'active')}\n${option('Suspended', 'suspended')}\n              ]}`, 'options={statusOptions}'),
      'export function CustomerList() {',
      'const statusOptions = [\n  { label: "Pending", value: "pending" },\n  { label: "Active", value: "active" },\n  { label: "Suspended", value: "suspended" },\n];\n\nexport function CustomerList() {',
    )
    write(LIST, list)
    await statuses(['pending', 'active', 'suspended', 'closed'])
    expect(await issueOf('CustomerList', 'status')).toBeUndefined()
    const refused = await plan(LIST, [{ action: 'align', column: 'status' }])
    expect(refused.status).toBe(422)
    expect(refused.body.error).toMatchObject({ code: 'unsupported', message: 'the Status filter `options={statusOptions}` is not a literal list Trivia can edit in place' })
    expect(read(LIST)).toBe(list)
  }, 60_000)

  it('offers a rebuild for options it can read but not edit one by one', async () => {
    const list = swap(originals.get(LIST)!, option('Suspended', 'suspended'), `${option('Suspended', 'suspended')}\n${option('On hold', 'suspended')}`)
    write(LIST, list)
    await statuses(['pending', 'active', 'suspended', 'closed'])
    const issue = await issueOf('CustomerList', 'status')
    expect(issue.fix).toEqual({ label: 'Rebuild column Status from the contract', changes: [{ action: 'rebuild', column: 'status' }] })
    const refused = await plan(LIST, [{ action: 'align', column: 'status' }])
    expect(refused.status).toBe(422)
    expect(refused.body.error.message).toBe('the Status filter options cannot be edited in place ("suspended" is written twice); rebuild the column instead')
  }, 60_000)

  it('reads a header longer than an excerpt, and fixes it in place; aligning again is a conflict', async () => {
    const note = `{/* ${'A long note about how this filter maps to the compliance workflow. '.repeat(10)}*/}`
    const list = swap(originals.get(LIST)!, '            <span>Status</span>\n', `            <span>Status</span>\n            ${note}\n`)
    write(LIST, list)
    await statuses(['pending', 'active', 'suspended', 'closed'])
    const page = (await get(server.socket, `/refine/page?file=${encodeURIComponent(LIST)}`)).body.data[0]
    // The excerpt stops before the Combobox.
    expect(page.columns.find((c: any) => c.key === 'status').headerSource.endsWith('…')).toBe(true)
    const issue = await issueOf('CustomerList', 'status')
    expect(issue.fix.changes).toEqual([{ action: 'align', column: 'status' }])
    await fix(LIST, issue.fix.changes)
    expect(read(LIST)).toBe(swap(list, option('Suspended', 'suspended'), `${option('Suspended', 'suspended')}\n${option('Closed', 'closed')}`))
    const again = await plan(LIST, issue.fix.changes)
    expect(again.status).toBe(409)
    expect(again.body.error).toMatchObject({ code: 'conflict', message: 'the Status filter options already match the contract' })
  }, 60_000)
})
