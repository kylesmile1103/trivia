import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

const repo = new URL('../../../', import.meta.url)
const script = fileURLToPath(new URL('tools/blueprint/check-kit-manifests.cjs', repo))
const samples = new URL('packages/blueprint/fixtures/manifests/kit-sample/', repo)
const check = (directory: string) => spawnSync(process.execPath, [script, directory], { encoding: 'utf8' })

it('FR-MF-02 checks inherited props and wrapper exports against the installed kit', () => {
  const result = check(fileURLToPath(samples))
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain('Checked 3 manifests')
}, 30_000)

it('FR-MF-02 reports stale prop, event and part names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trivia-kit-manifests-'))
  try {
    cpSync(samples, directory, { recursive: true })
    const file = join(directory, 'Input.manifest.json')
    const input = JSON.parse(readFileSync(file, 'utf8'))
    input.exposes[0].via.valueProp = 'staleValue'
    input.exposes[0].via.changeProp = 'onStaleChange'
    input.events[0].prop = 'onStaleEvent'
    input.source.parts = { label: 'MissingPart' }
    writeFileSync(file, JSON.stringify(input))
    const result = check(directory)
    expect(result.status).toBe(1)
    for (const name of ['staleValue', 'onStaleChange', 'onStaleEvent', 'MissingPart']) {
      expect(result.stderr).toContain('Input: ' + name)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
