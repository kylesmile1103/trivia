import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { APP_DOC, MODEL_DOC, revOfText, SCHEMA_URL } from '@trivia/blueprint'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { createStandaloneHost, startDevService, type RunningDevService } from '../src/standalone.js'

type Exec = (
  name: string, args: string[], options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn<Exec>() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile,
}))

let root: string
let running: RunningDevService

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trivia backend test ')))
  running = await startDevService(createStandaloneHost(root))
  execFile.mockReset()
})

afterEach(async () => {
  await running?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const post = (body: unknown) => fetch(`${running.url}/@trivia/api/blueprint/backend`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

const create = { path: 'src/Bank.Api/Customer.g.cs', kind: 'generated', action: 'create' }
const remove = { path: 'src/Bank.Api/Retired.g.cs', kind: 'generated', action: 'delete' }
const unchanged = { path: 'Bank.slnx', kind: 'scaffold', action: 'unchanged' }

function reply(stdout: unknown, stderr = '', error: Partial<ExecFileException> | null = null): void {
  execFile.mockImplementationOnce((_command, _args, _options, done) => {
    const failure = error && Object.assign(new Error('trivia-dotnet failed'), error)
    done(failure, stdout === undefined ? '' : JSON.stringify(stdout), stderr)
  })
}

it('FR-NC-01 plans through an argument array and preserves create, delete and unchanged actions', async () => {
  reply({ files: [create, remove, unchanged], diagnostics: [] }, 'line\n'.repeat(1_100))
  const response = await post({ mode: 'plan' })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    ok: true,
    data: { files: [create, remove, unchanged], written: false, diagnostics: [], log: expect.stringMatching(/line[\s\S]*truncated/) },
  })
  expect(execFile).toHaveBeenCalledExactlyOnceWith(
    'trivia-dotnet', ['plan', '--blueprint', path.join(root, 'blueprint'), '--root', root],
    expect.objectContaining({ cwd: root, shell: false, timeout: expect.any(Number) }), expect.any(Function),
  )
  expect(execFile.mock.calls[0]![2].timeout).toBeGreaterThan(0)
})

it('FR-NC-01 returns typed backend diagnostics and refused actions over MCP on exit 2', async () => {
  const diagnostics = [{ code: 'generated_modified', severity: 'error', doc: create.path, pointer: '', message: 'Changed on disk' }]
  reply({ files: [create, unchanged], diagnostics }, '', { code: 2 })
  const client = new Client({ name: 'backend-mcp-test', version: '0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/@trivia/mcp', running.url)) as unknown as Transport)
    const result = await client.callTool({ name: 'trivia_blueprint_backend', arguments: { mode: 'write', force: true } })
    expect(result).toMatchObject({ structuredContent: {
      files: [{ ...create, action: 'refused' }, unchanged], written: false, diagnostics, log: '',
    } })
    expect(result.isError).not.toBe(true)
  } finally {
    await client.close()
  }
  expect(execFile.mock.calls[0]?.[1]).toEqual(['write', '--blueprint', path.join(root, 'blueprint'), '--root', root, '--force'])
})

it('FR-AS-08 returns build, sync and drift steps after generation in a solution', async () => {
  await running.close()
  const web = path.join(root, 'web')
  const blueprint = path.join(web, 'blueprint')
  fs.mkdirSync(blueprint, { recursive: true })
  fs.writeFileSync(path.join(blueprint, APP_DOC), JSON.stringify({
    $schema: SCHEMA_URL.app, blueprintVersion: 1, name: 'Bank', targets: { web: 'vite-refine', api: 'dotnet-minimal' },
  }))
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ trivia: { solutionRoot: '..' } }))
  running = await startDevService(createStandaloneHost(web))
  reply({ files: [create], diagnostics: [] })
  const client = new Client({ name: 'backend-mcp-test', version: '0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/@trivia/mcp', running.url)) as unknown as Transport)
    const result = await client.callTool({ name: 'trivia_blueprint_backend', arguments: { mode: 'write' } })
    expect(result.structuredContent).toMatchObject({
      written: true,
      next: [
        { command: ['dotnet', 'build', 'Bank.slnx'], cwd: root },
        { tool: 'trivia_sync_openapi', arguments: { input: 'openapi/api.openapi.json', zod: true } },
        { tool: 'trivia_contract_drift', arguments: {} },
      ],
    })
  } finally {
    await client.close()
  }
  expect(execFile.mock.calls[0]?.[1]).toEqual(['write', '--blueprint', blueprint, '--root', root])
})

const migration = 'src/Bank.Api/Data/Migrations/20261125000000_AddOrders.cs'
const migrationFile = { path: migration, kind: 'scaffold', action: 'create' }
const bank = fs.readFileSync(path.resolve(import.meta.dirname, '../../blueprint/fixtures/model/valid/bank/model.blueprint.json'), 'utf8')
const modelPath = () => path.join(root, 'blueprint', MODEL_DOC)
const renamed = { kind: 'column', entity: 'Customer', field: 'fullName', from: 'legalName', oldName: 'customers.legal_name', newName: 'customers.full_name' }
const settled = [
  { entity: 'Customer', field: 'fullName', from: 'legalName', outcome: 'renamed' },
  { entity: 'Account', from: 'Ledger', outcome: 'notInDatabase' },
]

/** The bank model with two markers migrate settles and one it does not. */
function markedModel(): string {
  const model = JSON.parse(bank)
  model.entities[0].fields[0].renamedFrom = 'legalName'
  model.entities[0].fields[1].renamedFrom = 'mail'
  model.entities[1].renamedFrom = 'Ledger'
  const text = JSON.stringify(model, null, 2) + '\n'
  fs.mkdirSync(path.dirname(modelPath()), { recursive: true })
  fs.writeFileSync(modelPath(), text)
  return text
}

it('FR-NC-01 reports a successful write', async () => {
  reply({ files: [create], diagnostics: [] })
  expect(await (await post({ mode: 'write' })).json()).toMatchObject({
    ok: true, data: { files: [create], written: true },
  })
  expect(execFile).toHaveBeenCalledOnce()
})

it('FR-NC-12 writes before migrating in one call, reports the renames and clears the settled markers as one undo entry', async () => {
  // A stale .g.cs used to give an empty or wrong migration with exit 0: the migration call ran migrate alone.
  const before = markedModel()
  reply({ files: [create], diagnostics: [] }, 'generated\n')
  reply({ migration, modelRev: revOfText(before), renames: [renamed], settled, diagnostics: [] }, 'migrated\n')
  expect(await (await post({ mode: 'write', migration: 'AddOrders' })).json()).toMatchObject({
    ok: true, data: {
      files: [create, migrationFile], written: true, renames: [renamed], diagnostics: [],
      log: expect.stringMatching(/generated[\s\S]*migrated/), next: expect.arrayContaining([{ tool: 'trivia_contract_drift', arguments: {} }]),
    },
  })
  const shared = ['--blueprint', path.join(root, 'blueprint'), '--root', root]
  expect(execFile.mock.calls.map(([, args]) => args)).toEqual([['write', ...shared], ['migrate', 'AddOrders', ...shared]])

  const after = JSON.parse(fs.readFileSync(modelPath(), 'utf8'))
  expect(after.entities[0].fields[0]).not.toHaveProperty('renamedFrom')
  expect(after.entities[1]).not.toHaveProperty('renamedFrom')
  // migrate did not settle this one (as if it changed after migrate read the model), so it stays.
  expect(after.entities[0].fields[1].renamedFrom).toBe('mail')
  const history = await (await fetch(`${running.url}/@trivia/api/history`)).json()
  expect(history).toMatchObject({ data: { undoLabel: 'Clear migrated rename markers' } })
  await fetch(`${running.url}/@trivia/api/undo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect(fs.readFileSync(modelPath(), 'utf8')).toBe(before)
})

it('FR-NC-12 stops before migrating when the write is refused', async () => {
  const diagnostics = [{ code: 'generated_modified', severity: 'error', doc: create.path, pointer: '', message: 'Changed on disk' }]
  reply({ files: [create, unchanged], diagnostics }, '', { code: 2 })
  expect(await (await post({ mode: 'write', migration: 'AddOrders' })).json()).toMatchObject({
    ok: true, data: { files: [{ ...create, action: 'refused' }, unchanged], written: false, diagnostics },
  })
  expect(execFile).toHaveBeenCalledOnce()
})

it('FR-NC-12 returns migrate diagnostics and leaves the markers when the migration is refused', async () => {
  const before = markedModel()
  const refusal = { code: 'rename_drops_data', severity: 'error', doc: MODEL_DOC, pointer: '/entities/0/fields/0/renamedFrom', message: 'drops' }
  reply({ files: [create], diagnostics: [] })
  reply({ modelRev: revOfText(before), diagnostics: [refusal] }, '', { code: 1 })
  const body = await (await post({ mode: 'write', migration: 'AddOrders' })).json() as { data: object }
  expect(body).toMatchObject({ ok: true, data: { files: [create], written: true, diagnostics: [refusal] } })
  expect(body.data).not.toHaveProperty('next')
  expect(fs.readFileSync(modelPath(), 'utf8')).toBe(before)
})

it('FR-NC-12 says loudly that the markers were not cleared when the model changed after migrate read it', async () => {
  const before = markedModel()
  reply({ files: [create], diagnostics: [] })
  reply({ migration, modelRev: revOfText(bank), renames: [renamed], settled, diagnostics: [] })
  const response = await post({ mode: 'write', migration: 'AddOrders' })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    error: {
      code: 'conflict', message: expect.stringMatching(/AddOrders\.cs was added, but its rename markers were not cleared/),
      details: { migration, renames: [renamed], markers: [
        { entity: 'Customer', field: 'fullName', from: 'legalName' }, { entity: 'Account', from: 'Ledger' },
      ] },
    },
  })
  expect(fs.readFileSync(modelPath(), 'utf8')).toBe(before)
})

it('NFR-05 passes the no-authentication warning through once without blocking the next steps', async () => {
  const warning = {
    code: 'auth_none', severity: 'warning', doc: 'app.blueprint.json', pointer: '', message: 'Publish behind oidc or a gateway.',
  }
  reply({ files: [create], diagnostics: [warning] })
  expect(await (await post({ mode: 'plan' })).json()).toMatchObject({ ok: true, data: { diagnostics: [warning] } })
  reply({ files: [create], diagnostics: [warning] })
  const { data } = await (await post({ mode: 'write' })).json() as { data: { diagnostics: unknown[] } }
  expect(data).toMatchObject({ written: true, diagnostics: [warning], next: expect.any(Array) })
  expect(data.diagnostics).toHaveLength(1)
})

it('NFR-05 refuses option-like migration names and a symlinked blueprint before starting a child', async () => {
  const invalid = await post({ mode: 'write', migration: '--root=/outside' })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_op' } })
  fs.mkdirSync(path.join(root, 'other'))
  fs.symlinkSync(path.join(root, 'other'), path.join(root, 'blueprint'), 'junction')
  const escaped = await post({ mode: 'plan' })
  expect(escaped.status).toBe(422)
  expect(await escaped.json()).toMatchObject({ error: { code: 'path_outside_root' } })
  expect(execFile).not.toHaveBeenCalled()
})

it('FR-NC-01 distinguishes a missing dotnet SDK and a missing trivia-dotnet tool', async () => {
  reply(undefined, '', { code: 'ENOENT' })
  reply(undefined, '', { code: 'ENOENT' })
  const noSdk = await post({ mode: 'plan' })
  expect(noSdk.status).toBe(422)
  expect(await noSdk.json()).toMatchObject({
    error: { code: 'unsupported', message: expect.stringContaining('dotnet'), details: { hint: expect.stringContaining('.NET 10 SDK') } },
  })
  expect(execFile.mock.calls[1]?.slice(0, 2)).toEqual(['dotnet', ['--version']])

  reply(undefined, '', { code: 'ENOENT' })
  reply('10.0.100')
  const noTool = await post({ mode: 'plan' })
  expect(noTool.status).toBe(422)
  expect(await noTool.json()).toMatchObject({
    error: { code: 'unsupported', message: expect.stringContaining('trivia-dotnet'), details: { hint: expect.stringContaining('PATH') } },
  })
})

it('FR-NC-01 reports a timed-out tool invocation with bounded logs', async () => {
  reply(undefined, 'waiting for the tool', { code: null, killed: true, signal: 'SIGTERM' })
  const response = await post({ mode: 'plan' })
  expect(response.status).toBe(500)
  expect(await response.json()).toMatchObject({
    error: { code: 'io_error', message: expect.stringContaining('timed out'), details: { log: 'waiting for the tool', timeoutMs: expect.any(Number) } },
  })
})
