import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { blueprint, missingMvpPrerequisite, prepareMvp, run, startMvpApi } from './mvp-project.mjs'

test('FR-MVP-01, FR-MVP-02: generate, type-check and run BankAdmin on Aspire', {
  skip: missingMvpPrerequisite(),
  timeout: 600_000,
}, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'trivia-mvp-'))
  let api
  t.after(async () => {
    try {
      await api?.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  const web = prepareMvp(root)
  const backend = blueprint(root, 'backend', '--migration', 'Initial')
  assert.match(backend, /No contract drift\./)
  assert.deepEqual(JSON.parse(blueprint(root, 'validate', '--json')), [])
  const eject = JSON.parse(blueprint(root, 'eject'))
  assert.deepEqual(eject.files.filter((file) => file.startsWith('src/pages/')).sort(), [
    'src/pages/accounts/list.tsx',
    'src/pages/customers/create.tsx',
    'src/pages/customers/edit.tsx',
    'src/pages/customers/list.tsx',
    'src/pages/customers/show.tsx',
  ])
  assert.ok(existsSync(path.join(web, 'trivia.manifest.json')))
  run(root, 'dotnet', ['build', 'BankAdmin.slnx', '-warnaserror', '--disable-build-servers'])
  run(web, 'pnpm', ['exec', 'tsc', '--noEmit'])

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
})
