import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { APP_DOC, appSchema, BLUEPRINT_VERSION, SCHEMA_URL, serialize } from '@trivia/blueprint'
import { afterEach, beforeEach, expect, it } from 'vitest'

const bin = path.resolve(import.meta.dirname, '../bin/trivia-blueprint.js')
const fixture = path.resolve(import.meta.dirname, '../../../examples/refine-admin')
let root: string

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-blueprint-cli-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function cli(...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' })
}

it('copies a template and writes a canonical empty blueprint, without fetching components', () => {
  const result = cli('new', 'bank-admin', '--target', 'vite-refine')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('shadcn add https://ui.refine.dev/r/layout-01.json')
  const dir = path.join(root, 'bank-admin')
  const app = fs.readFileSync(path.join(dir, 'blueprint', APP_DOC), 'utf8')
  expect(app).toBe(serialize(appSchema.parse({
    $schema: SCHEMA_URL.app, blueprintVersion: BLUEPRINT_VERSION, name: 'BankAdmin', targets: { web: 'vite-refine' },
  })))
  expect(fs.existsSync(path.join(dir, 'vite.config.ts'))).toBe(true)
  expect(fs.existsSync(path.join(dir, 'src/components'))).toBe(false)
  expect(cli('new', 'bank-admin').status).toBe(1)
  expect(cli('new', 'unknown-admin', '--target', 'unknown-refine').status).toBe(2)
  expect(cli('compile', '--out').status).toBe(2)
}, 30_000) // five CLI processes: past Vitest's default 5 s while the gate runs other projects

it('wires pnpm sync to the emitted API contract and includes its dependencies', () => {
  expect(cli('new', 'bank-admin').status).toBe(0)
  const app = JSON.parse(fs.readFileSync(path.join(root, 'bank-admin/package.json'), 'utf8'))
  expect(app.scripts.sync).toBe('trivia-contract-sync --input openapi/api.openapi.json --zod')
  expect(app.devDependencies['@trivia/contract-sync']).toBe('link:' + path.resolve(import.meta.dirname, '../../contract-sync'))
  expect(app.dependencies.zod).toBe('4.6.6')
})

it('validates, compiles, plans and ejects offline using the shared project adapter', () => {
  fs.cpSync(path.join(fixture, 'src'), path.join(root, 'src'), { recursive: true })
  for (const file of ['components.json', 'trivia.manifest.json']) fs.copyFileSync(path.join(fixture, file), path.join(root, file))
  fs.symlinkSync(path.join(fixture, 'node_modules'), path.join(root, 'node_modules'), 'junction')
  const dir = path.join(root, 'blueprint/pages')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(root, 'blueprint', APP_DOC), serialize(appSchema.parse({
    $schema: SCHEMA_URL.app, blueprintVersion: BLUEPRINT_VERSION, name: 'Bank', targets: { web: 'vite-refine' },
  })))
  const draft = path.join(dir, 'CliList.page.json')
  fs.writeFileSync(draft, '{')
  const invalid = cli('validate', '--json')
  expect(invalid.status, invalid.stderr).toBe(1)
  expect(JSON.parse(invalid.stdout)).toEqual([expect.objectContaining({ code: 'invalid_json' })])
  const page = { $schema: SCHEMA_URL.page, blueprintVersion: BLUEPRINT_VERSION,
    id: 'pg_00000000000000000000000001', name: 'CliList', kind: 'list', resource: 'Absent', route: '/cli-list' }
  fs.writeFileSync(draft, JSON.stringify(page))
  const unknown = cli('validate', '--json')
  expect(unknown.status, unknown.stderr).toBe(1)
  expect(JSON.parse(unknown.stdout)).toEqual([expect.objectContaining({ code: 'unknown_resource' })])
  fs.writeFileSync(draft, JSON.stringify({ ...page, resource: 'Account' }))
  const validated = cli('validate', '--json')
  expect(validated.status, validated.stderr).toBe(0)
  expect(JSON.parse(validated.stdout)).toEqual([])
  const compiled = cli('compile', 'CliList')
  expect(compiled.status, compiled.stderr).toBe(0)
  expect(compiled.stdout).toContain('function AccountList')
  expect(cli('compile', 'CliList', '--out', 'compiled.tsx').status).toBe(0)
  expect(fs.readFileSync(path.join(root, 'compiled.tsx'), 'utf8')).toBe(compiled.stdout)

  // Account already has a list in the fixture. Remove its registration and file before eject.
  const app = path.join(root, 'src/App.tsx')
  const original = fs.readFileSync(app, 'utf8').replace(/^.*AccountList.*\n/gm, '')
    .replace(/          \{\n            name: "accounts",[\s\S]*?\n          \},\n/, '')
  fs.writeFileSync(app, original)
  const file = path.join(root, 'src/pages/accounts/list.tsx')
  fs.rmSync(file)
  const lock = path.join(root, 'blueprint/blueprint.lock.json')
  const dry = cli('eject', '--dry-run', 'CliList')
  expect(dry.status, dry.stderr).toBe(0)
  expect(JSON.parse(dry.stdout)).toMatchObject({ files: ['src/pages/accounts/list.tsx'] })
  expect(fs.readFileSync(app, 'utf8')).toBe(original)
  expect(fs.existsSync(file)).toBe(false)
  expect(fs.existsSync(lock)).toBe(false)
  const applied = cli('eject', 'CliList')
  expect(applied.status, applied.stderr).toBe(0)
  expect(fs.readFileSync(file, 'utf8')).toBe(compiled.stdout)
  expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pages).toHaveProperty('CliList')
  fs.appendFileSync(file, '// hand edit\n')
  expect(cli('eject', 'CliList')).toMatchObject({ status: 1, stderr: expect.stringContaining('conflict') })
  expect(fs.readFileSync(file, 'utf8')).toBe(compiled.stdout + '// hand edit\n')
}, 120_000) // nine CLI processes: 4 s here, 39 s on an uncached nightly runner compiling Rust beside it
