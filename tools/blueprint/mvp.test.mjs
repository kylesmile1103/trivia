import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  applyRefineChange, blueprint, followCustomerDrift, missingMvpPrerequisite, prepareMvp, reviseCustomerModel,
  run, startMvpApi, startMvpDevService, triviaRequest,
} from './mvp-project.mjs'

test('FR-MVP-01, FR-MVP-02: generate, type-check and run BankAdmin on Aspire', {
  skip: missingMvpPrerequisite(),
  timeout: 600_000,
}, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'trivia-mvp-'))
  let api
  let dev
  t.after(async () => {
    try {
      await Promise.all([api?.close(), dev?.close()])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  const web = await prepareMvp(root)
  const backend = await blueprint(root, 'backend', '--migration', 'Initial')
  assert.match(backend, /No contract drift\./)
  assert.deepEqual(JSON.parse(await blueprint(root, 'validate', '--json')), [])
  const eject = JSON.parse(await blueprint(root, 'eject'))
  assert.deepEqual(eject.files.filter((file) => file.startsWith('src/pages/')).sort(), [
    'src/pages/accounts/list.tsx',
    'src/pages/customers/create.tsx',
    'src/pages/customers/edit.tsx',
    'src/pages/customers/list.tsx',
    'src/pages/customers/show.tsx',
  ])
  assert.ok(existsSync(path.join(web, 'trivia.manifest.json')))
  await run(root, 'dotnet', ['build', 'BankAdmin.slnx', '-warnaserror', '--disable-build-servers'])
  await run(web, 'pnpm', ['exec', 'tsc', '--noEmit'])

  api = await startMvpApi(root)
  const customers = new URL('/api/v1/customers', api.url)
  const record = { fullName: 'MVP Customer', email: 'mvp@example.test', status: 'active' }
  const created = await fetch(customers, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record),
    signal: AbortSignal.timeout(15_000),
  })
  assert.equal(created.status, 201, await created.clone().text())
  const item = await created.json()
  assert.ok(item.id)
  const response = await fetch(customers, { signal: AbortSignal.timeout(15_000) })
  assert.equal(response.status, 200)
  const { total, items } = await response.json()
  assert.equal(total, 1)
  assert.deepEqual(items, [item])
  assert.deepEqual({ fullName: item.fullName, email: item.email, status: item.status }, record)
  await api.close()
  api = undefined

  dev = await startMvpDevService(web)
  const edit = 'src/pages/customers/edit.tsx'
  const editSource = () => readFileSync(path.join(web, edit), 'utf8')
  await applyRefineChange(dev.url, 'fields', edit, [{ action: 'add', field: 'notes' }])
  assert.match(editSource(), /name="notes"/)

  assert.deepEqual((await triviaRequest(dev.url, '/refine/drift')).pages, [])
  const before = backendFiles(root)
  const segment = await reviseCustomerModel(dev.url, web)
  const { added, removed } = lineChanges(segment.before, segment.after)
  assert.ok(added > 0 && added + removed < 10, 'A single field must change fewer than ten model lines')
  t.diagnostic('SC-004: ' + (added + removed) + ' changed lines in the field patch (+' + added + ' / -' + removed + ')')
  const migration = await blueprint(root, 'backend', '--migration', 'Segment')
  assert.match(migration, /src\/pages\/customers\/edit\.tsx +Field Notes sends .notes./)
  const after = backendFiles(root)
  const generatedFiles = assertMigration(before, after)
  t.diagnostic('SC-004: ' + generatedFiles + ' changed .g.cs files plus one EF migration')

  const { pages } = await triviaRequest(dev.url, '/refine/drift')
  assert.equal(pages.length, 1)
  assert.equal(pages[0].file, edit)
  assert.equal(pages[0].issues.length, 1)
  const [issue] = pages[0].issues
  assert.equal(issue.code, 'missing_field')
  assert.equal(issue.name, 'notes')
  assert.deepEqual(issue.fix?.changes, [{ action: 'remove', field: 'notes' }])

  await followCustomerDrift(dev.url, issue.fix.changes)
  assert.doesNotMatch(editSource(), /\bnotes\b/)
  const list = readFileSync(path.join(web, 'src/pages/customers/list.tsx'), 'utf8')
  assert.match(list, /accessorKey: "segment"/)
  assert.deepEqual((await triviaRequest(dev.url, '/refine/drift')).pages, [])
  await run(web, 'pnpm', ['exec', 'tsc', '--noEmit'])
})


function backendFiles(root) {
  const files = new Map()
  function read(dir) {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = path.posix.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!['web', 'bin', 'obj', '.mvp-host'].includes(entry.name)) read(file)
      } else if (entry.isFile()) {
        files.set(file, readFileSync(path.join(root, file), 'utf8'))
      }
    }
  }
  read('')
  return files
}

function assertMigration(before, after) {
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file)).sort()
  const migrationDir = 'src/BankAdmin.Api/Data/Migrations/'
  const migrations = changed.filter((file) => file.startsWith(migrationDir))
  const main = migrations.find((file) => /\/\d{14}_Segment\.cs$/.test(file))
  assert.ok(main, 'Expected the new Segment migration')
  assert.equal(before.has(main), false)
  const designer = main.replace(/\.cs$/, '.Designer.cs')
  assert.equal(before.has(designer), false)
  assert.deepEqual(migrations, [main, designer, migrationDir + 'AppDbContextModelSnapshot.cs'].sort())
  assert.match(after.get(main), /DropColumn\(\s*name: "notes",\s*table: "customers"/)
  assert.match(after.get(main), /AddColumn<string>\(\s*name: "segment",\s*table: "customers"/)
  const backend = changed.filter((file) => !migrations.includes(file))
  assert.ok(backend.some((file) => file.endsWith('/Customer.g.cs')), backend.join('\n'))
  assert.ok(backend.every((file) => file.endsWith('.g.cs')), backend.join('\n'))
  return backend.length
}


// A single ordered field insertion has one changed region, bounded by identical lines.
function lineChanges(before, after) {
  const old = before.split('\n')
  const next = after.split('\n')
  const shorter = Math.min(old.length, next.length)
  let prefix = 0
  while (prefix < shorter && old[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (suffix < shorter - prefix && old.at(-1 - suffix) === next.at(-1 - suffix)) suffix++
  return { added: next.length - prefix - suffix, removed: old.length - prefix - suffix }
}
