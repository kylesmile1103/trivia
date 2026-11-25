import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

const kit = path.resolve(import.meta.dirname, '../../../examples/blueprint-kit')
const cli = path.resolve(import.meta.dirname, '../bin/trivia-blueprint.js')
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')

it('FR-MVP-01: the standalone Vite scaffold type-checks with the installed kit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-scaffold-tsc-'))
  try {
    execFileSync(process.execPath, [cli, 'new', root], { encoding: 'utf8' })
    const modules = path.join(root, 'node_modules')
    const installed = path.join(kit, 'node_modules')
    fs.mkdirSync(modules)
    for (const entry of fs.readdirSync(installed)) {
      fs.symlinkSync(path.join(installed, entry), path.join(modules, entry), 'junction')
    }
    fs.symlinkSync(path.resolve(kit, '../refine-admin/node_modules/sonner'), path.join(modules, 'sonner'), 'junction')
    for (const source of ['components', 'hooks', 'lib']) {
      fs.cpSync(path.join(kit, 'src', source), path.join(root, 'src', source), { recursive: true })
    }
    const result = spawnSync(process.execPath, [tsc, '--noEmit'], { cwd: root, encoding: 'utf8', timeout: 60_000 })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
