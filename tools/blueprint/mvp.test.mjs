import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { blueprint, missingMvpPrerequisite, prepareMvp, run } from './mvp-project.mjs'

test('FR-MVP-01, FR-MVP-02: build and type-check the generated BankAdmin solution', {
  skip: missingMvpPrerequisite(),
  timeout: 600_000,
}, (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'trivia-mvp-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
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
})
