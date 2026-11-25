import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { dotnetAvailable, mvpContract, nextExample, prepareMvp } from './next-fixture.js'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const bin = fileURLToPath(new URL('../bin/trivia-blueprint.js', import.meta.url))
const routes = ['accounts', 'customers', 'customers/create', 'customers/edit/[id]', 'customers/show/[id]']

function node(cwd: string, program: string, ...args: string[]) {
  return spawnSync(process.execPath, [program, ...args], {
    cwd, timeout: 120_000, encoding: 'utf8', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  })
}

it.skipIf(!dotnetAvailable)('FR-NX-08 ejects, guards and type-checks the complete Next app (requires .NET SDK)', async () => {
  const temp = path.join(workspace, '.nx')
  fs.mkdirSync(temp, { recursive: true })
  const root = fs.mkdtempSync(path.join(temp, 'next-eject-'))
  try {
    const created = node(root, bin, 'new', 'cli', '--target', 'next-refine', '--api', 'dotnet-minimal')
    expect(created.status, created.stdout + created.stderr).toBe(0)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'cli/web/blueprint/app.blueprint.json'), 'utf8')).targets).toEqual({
      web: 'next-refine', api: 'dotnet-minimal',
    })
    expect(fs.existsSync(path.join(root, 'cli/web/next.config.ts'))).toBe(true)

    const web = prepareMvp(root)
    await mvpContract(root, web)
    fs.symlinkSync(fileURLToPath(new URL('node_modules', nextExample)), path.join(web, 'node_modules'), 'junction')
    const ejected = node(web, bin, 'eject')
    expect(ejected.status, ejected.stdout + ejected.stderr).toBe(0)
    for (const route of routes) {
      expect(fs.existsSync(path.join(web, 'app/(app)', route, 'page.tsx'))).toBe(true)
      expect(fs.existsSync(path.join(web, 'app/(app)', route, 'view.tsx'))).toBe(true)
    }
    const provider = fs.readFileSync(path.join(web, 'app/providers.tsx'), 'utf8')
    expect(provider).toContain('show: "/customers/show/:id"')
    expect(provider).not.toContain('<Route')
    const nextCli = 'node_modules/next/dist/bin/next'
    const types = node(web, nextCli, 'typegen')
    expect(types.status, types.stdout + types.stderr).toBe(0)
    const checked = node(web, 'node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false')
    expect(checked.status, checked.stdout + checked.stderr).toBe(0)
    if (process.env.TRIVIA_NEXT_BUILD === '1') {
      const built = node(web, nextCli, 'build')
      expect(built.status, built.stdout + built.stderr).toBe(0)
    }

    const replay = node(web, bin, 'eject', 'CustomerShow')
    expect(replay.status, replay.stdout + replay.stderr).toBe(0)
    const view = path.join(web, 'app/(app)/customers/show/[id]/view.tsx')
    fs.appendFileSync(view, '\n// Hand edit\n')
    const refused = node(web, bin, 'eject', 'CustomerShow')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('view.tsx changed since its last eject')
    expect(fs.readFileSync(view, 'utf8')).toMatch(/\/\/ Hand edit\n$/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 240_000)
