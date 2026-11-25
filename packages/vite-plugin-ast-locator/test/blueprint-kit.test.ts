import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { expect, it } from 'vitest'

import { post, socketFetch, startServer } from './helpers.js'

const example = path.resolve(import.meta.dirname, '../../../examples/blueprint-kit')
const fixture = path.resolve(import.meta.dirname, '../../blueprint-compiler/fixtures/kit')

async function withEjectedPage(name: string, run: (root: string, file: string, client: Client, socket: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-kit-plugin-'))
  try {
    for (const entry of ['src', 'openapi', 'package.json', 'components.json', 'trivia.manifest.json', 'tsconfig.json']) {
      fs.cpSync(path.join(example, entry), path.join(root, entry), { recursive: true })
    }
    fs.symlinkSync(path.join(example, 'node_modules'), path.join(root, 'node_modules'), 'junction')
    fs.mkdirSync(path.join(root, 'blueprint/pages'), { recursive: true })
    fs.copyFileSync(path.join(fixture, 'app.blueprint.json'), path.join(root, 'blueprint/app.blueprint.json'))
    const page = `pages/${name}.page.json`
    fs.copyFileSync(path.join(fixture, page), path.join(root, 'blueprint', page))
    const server = await startServer(root)
    const client = new Client({ name: 'kit-test', version: '0.0.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/@trivia/mcp'), {
        fetch: socketFetch(server.socket),
      }) as unknown as Transport)
      const ejected = await client.callTool({
        name: 'trivia_blueprint_eject', arguments: { pages: [name], label: 'Eject kit page' },
      })
      expect(ejected.isError, JSON.stringify(ejected.content)).toBeFalsy()
      const file = `src/pages/${name}/${name}.tsx`
      expect(fs.existsSync(path.join(root, file))).toBe(true)
      await run(root, file, client, server.socket)
    } finally {
      await client.close()
      await server.close()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

it('SC-004 adds, moves and removes columns through MCP after blueprint eject', async () => {
  await withEjectedPage('KitTable', async (root, file, client, socket) => {
    const read = () => fs.readFileSync(path.join(root, file), 'utf8')
    const before = read()
    const edited = await client.callTool({ name: 'trivia_edit_columns', arguments: {
      file, changes: [
        { action: 'add', field: 'kycStatus' },
        { action: 'move', column: 'kycStatus', index: 2 },
        { action: 'remove', column: 'email' },
      ], label: 'Change ejected table columns',
    } })
    expect(edited.isError, JSON.stringify(edited.content)).toBeFalsy()
    const data = edited.structuredContent as { page: { columns: Array<{ key: string }> } }
    expect(data.page.columns.map(({ key }) => key)).toEqual(['selection', 'fullName', 'kycStatus', 'status', 'createdAt'])
    expect(read()).toContain('id: "kycStatus"')
    expect(read()).toContain('customersSelectedRow.id')
    expect((await post(socket, '/undo')).status).toBe(200)
    expect(read()).toBe(before)
  })
}, 60_000)

it('SC-004 edits an ejected form and aligns a changed contract bound in place', async () => {
  await withEjectedPage('KitForm', async (root, file, client, socket) => {
    const read = () => fs.readFileSync(path.join(root, file), 'utf8')
    const edit = async (changes: unknown[], label: string) => {
      const result = await client.callTool({ name: 'trivia_edit_fields', arguments: { file, changes, label } })
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
      return result.structuredContent as { page: { fields: Array<{ name: string }> } }
    }
    const added = await edit([{ action: 'add', field: 'phone', index: 2 }], 'Collect phone')
    expect(added.page.fields.map(({ name }) => name)).toEqual(['fullName', 'email', 'phone', 'segment', 'notes'])
    const before = read()
    expect(before).toContain('phone: z.string().nullable().optional()')
    expect(before).toContain('phone: undefined')
    expect(before).toContain('name="phone"')

    const openapi = path.join(root, 'openapi/bank.openapi.json')
    const spec = JSON.parse(fs.readFileSync(openapi, 'utf8'))
    spec.components.schemas.CreateCustomerRequest.properties.notes.maxLength = 800
    fs.writeFileSync(openapi, JSON.stringify(spec, null, 2) + '\n')
    const synced = await post(socket, '/sync')
    expect(synced.status, JSON.stringify(synced.body)).toBe(200)
    const drift = async () => {
      const result = await client.callTool({ name: 'trivia_contract_drift' })
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
      return result.structuredContent as { pages: Array<{ file: string; issues: Array<{
        code: string; name: string; fix: { changes: unknown[]; label: string }
      }> }> }
    }
    const issues = (await drift()).pages.find((page) => page.file === file)?.issues
    expect(issues).toEqual([expect.objectContaining({ code: 'constraint_changed', name: 'notes' })])
    const { fix } = issues![0]!
    await edit(fix.changes, fix.label)
    expect(read()).toBe(before.replace('1000, "Enter at most 1000 characters."', '800, "Enter at most 800 characters."'))
    expect((await drift()).pages).toEqual([])
  })
}, 60_000)
