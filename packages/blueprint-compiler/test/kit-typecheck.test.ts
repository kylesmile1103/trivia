import { spawnSync } from 'node:child_process'
import { copyFileSync, globSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { fixture, fixtureDir, kitApp, kitManifests } from './kit-fixture.js'

const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const script = fileURLToPath(new URL('../../../tools/blueprint/check-kit-manifests.cjs', import.meta.url))
const manifests = fileURLToPath(new URL('../kit/', import.meta.url))

it('FR-KT-06 checks every published manifest and type-checks all Radix goldens', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain(`Checked ${kitManifests().length} manifests`)
  const golden = new URL('golden/', fixtureDir)
  const names = globSync('*.tsx', { cwd: fileURLToPath(golden) }).sort()
  const pages = Object.keys(fixture()).filter((name) => name.endsWith('.page.json'))
  expect(names).toEqual(pages.map((file) => path.basename(file, '.page.json') + '.tsx').sort())
  checkTypes(kitApp, 'tsconfig.json', names.map((name) => new URL(name, golden)))
}, 60_000)

it('FR-KT-03 type-checks the legacy FormField golden against the installed Refine controls', () => {
  const app = new URL('../../../examples/refine-admin/', import.meta.url)
  checkTypes(app, 'tsconfig.app.json', [new URL('golden/form-field/KitForm.tsx', fixtureDir)])
}, 60_000)

it('SC-002 checks Base UI variants and type-checks the fixture with both component libraries', () => {
  const app = new URL('base-ui/', kitApp)
  const result = spawnSync(process.execPath, [script, manifests, fileURLToPath(app)], { encoding: 'utf8' })
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain(`Checked ${kitManifests().length} manifests against base-nova`)
  const pages = Object.keys(fixture()).filter((name) => name.endsWith('.page.json'))
  const sources = pages.map((file) => {
    const name = path.basename(file, '.page.json') + '.tsx'
    return new URL('golden/base-ui/' + name, fixtureDir)
  })
  checkTypes(app, 'tsconfig.json', sources, kitApp)
}, 60_000)

function checkTypes(project: URL, config: string, sources: URL[], dependencies = project) {
  const app = fileURLToPath(project)
  const temp = mkdtempSync(path.join(tmpdir(), 'trivia-kit-tsc-'))
  try {
    symlinkSync(fileURLToPath(new URL('node_modules', dependencies)), path.join(temp, 'node_modules'), 'junction')
    const include = [path.join(app, 'src', '**', '*')]
    for (const source of sources) {
      const name = path.basename(fileURLToPath(source))
      const target = path.join(temp, 'src/pages', path.basename(name, '.tsx'), name)
      mkdirSync(path.dirname(target), { recursive: true })
      copyFileSync(source, target)
      include.push(target)
    }
    writeFileSync(path.join(temp, 'tsconfig.json'), JSON.stringify({ extends: path.join(app, config), include }))
    const tsc = spawnSync(process.execPath, [compiler, '-p', temp, '--pretty', 'false'], { encoding: 'utf8' })
    expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
