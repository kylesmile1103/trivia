import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { APP_DOC, appSchema, BLUEPRINT_VERSION, SCHEMA_URL, serialize } from '@trivia/blueprint'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { registryCommands } from '../src/cli.js'

const bin = path.resolve(import.meta.dirname, '../bin/trivia-blueprint.js')
const fixture = path.resolve(import.meta.dirname, '../../../examples/refine-admin')
const kit = path.resolve(import.meta.dirname, '../kit')
const install = 'pnpm exec shadcn add '
const refineItem = (item: string) => 'https://ui.refine.dev/r/' + item + '.json'
let root: string

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-blueprint-cli-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function cli(...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' })
}

/** The distinct registry items of the shipped kit manifests, byte-sorted. */
function kitItems(registry: string): string[] {
  const sources = fs.readdirSync(kit).filter((file) => file.endsWith('.manifest.json'))
    .map((file) => (JSON.parse(fs.readFileSync(path.join(kit, file), 'utf8')) as { source: { registry: string; item: string } }).source)
  return [...new Set(sources.filter((source) => source.registry === registry).map(({ item }) => item))].sort()
}

/** What `new` installs from Refine UI: the template's layout and views, and the kit's items. */
const refineItems = () => [...new Set(['layout-01', 'views', ...kitItems('refine')])].sort().map(refineItem)

/** The arguments of each printed install line. */
function installLines(output: string): string[][] {
  return output.split('\n').map((line) => line.trim()).filter((line) => line.startsWith(install))
    .map((line) => line.slice(install.length).split(' '))
}

/** A copy of the Refine example's sources and installed packages, with an empty blueprint. */
function refineProject(): void {
  fs.cpSync(path.join(fixture, 'src'), path.join(root, 'src'), { recursive: true })
  for (const file of ['components.json', 'trivia.manifest.json']) fs.copyFileSync(path.join(fixture, file), path.join(root, file))
  fs.symlinkSync(path.join(fixture, 'node_modules'), path.join(root, 'node_modules'), 'junction')
  fs.mkdirSync(path.join(root, 'blueprint/pages'), { recursive: true })
  fs.writeFileSync(path.join(root, 'blueprint', APP_DOC), serialize(appSchema.parse({
    $schema: SCHEMA_URL.app, blueprintVersion: BLUEPRINT_VERSION, name: 'Bank', targets: { web: 'vite-refine' },
  })))
}

it('copies a template and writes a canonical empty blueprint, without fetching components', () => {
  const result = cli('new', 'bank-admin', '--target', 'vite-refine')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain(refineItem('layout-01'))
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

it('FR-RC-12 prints one install line for the kit\'s shadcn items and one for Refine UI, derived from the manifests', () => {
  const created = cli('new', 'bank-admin', '--target', 'vite-refine')
  expect(created.status, created.stderr).toBe(0)
  expect(refineItems()).toContain(refineItem('data-table'))
  expect(installLines(created.stdout)).toEqual([kitItems('shadcn'), refineItems()])
  fs.rmSync(path.join(root, 'bank-admin'), { recursive: true })
  expect(cli('new', 'bank-admin', '--target', 'vite-refine').stdout).toBe(created.stdout)
}, 30_000)

it('FR-RC-12 prints the same kit and Refine UI install lines for a Next.js project', () => {
  // The kit is target-independent; the Next template's components.json sets rsc: true, so the
  // shadcn CLI adds the client directives itself.
  const created = cli('new', 'bank-next', '--target', 'next-refine')
  expect(created.status, created.stderr).toBe(0)
  expect(installLines(created.stdout)).toEqual([kitItems('shadcn'), refineItems()])
}, 30_000)

it('FR-KT-01 keeps the registry commands of LLD-06 section 7 equal to the shipped kit', () => {
  const design = fs.readFileSync(path.resolve(import.meta.dirname, '../../../docs/blueprint/lld/LLD-06-component-kit.md'), 'utf8')
  const section = /^## 7\. Registry installation\n([\s\S]*?)^## 8\./m.exec(design)?.[1] ?? ''
  const block = /```sh\n([\s\S]*?)```/.exec(section)?.[1] ?? ''
  // The fixture's commands pin the shadcn CLI; compare what each one adds, not how it is run.
  const added = block.replaceAll('\\\n', ' ').split('\n').filter(Boolean).map((line) => {
    const words = line.trim().split(/\s+/)
    return words.slice(words.indexOf('add') + 1).sort()
  })
  expect(added).toEqual([kitItems('shadcn'), refineItems()])
})

it('FR-RC-10 groups registry items into one byte-sorted install line per registry', () => {
  expect(registryCommands([
    { registry: 'shadcn', item: 'select' }, { registry: 'refine', item: 'views' }, { registry: 'shadcn', item: 'button' },
    { registry: 'shadcn', item: 'select' }, { registry: 'local', item: 'Ledger' }, { registry: 'refine', item: 'data-table' },
    { registry: 'shadcn', item: "it's" },
  ])).toEqual([
    install + "button 'it'\\''s' select",
    install + refineItem('data-table') + ' ' + refineItem('views'),
  ])
  expect(registryCommands([{ registry: 'local', item: 'Ledger' }])).toEqual([])
})

it('wires pnpm sync to the emitted API contract and includes its dependencies', () => {
  expect(cli('new', 'bank-admin').status).toBe(0)
  const app = JSON.parse(fs.readFileSync(path.join(root, 'bank-admin/package.json'), 'utf8'))
  expect(app.scripts.sync).toBe('trivia-contract-sync --input openapi/api.openapi.json --zod')
  expect(app.devDependencies['@trivia/contract-sync']).toBe('link:' + path.resolve(import.meta.dirname, '../../contract-sync'))
  expect(app.dependencies.zod).toBe('4.6.6')
})

it('validates, compiles, plans and ejects offline using the shared project adapter', () => {
  refineProject()
  const dir = path.join(root, 'blueprint/pages')
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

it('FR-RC-10 prints the install line for only the kit component an ejected page lacks', () => {
  refineProject()
  // The example installs no card, and lacks other kit components too: only the page's one is printed.
  expect(fs.existsSync(path.join(root, 'src/components/ui/card.tsx'))).toBe(false)
  const page = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/pages/static/StaticPage.page.json'), 'utf8')
  fs.writeFileSync(path.join(root, 'blueprint/pages/StaticPage.page.json'), page.replace('"type": "Button"', '"type": "Card"'))
  const ejected = cli('eject', 'StaticPage')
  const output = ejected.stdout + ejected.stderr
  expect(ejected.status, output).toBe(1)
  expect(output).toContain('unresolved_component')
  expect(output).toContain(install + 'card\n')
  expect(installLines(output)).toEqual([['card']])
}, 60_000)
