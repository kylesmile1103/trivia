import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { expect, it } from 'vitest'

const fixture = new URL('../../../examples/blueprint-fixture/', import.meta.url)

it('type-checks the Refine fixture against the banking mock contract', () => {
  const result = spawnSync(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '--noEmit'], { cwd: fixture, encoding: 'utf8' })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stdout + result.stderr).toBe(0)

  const manifest = JSON.parse(readFileSync(new URL('../refine-admin/trivia.manifest.json', fixture), 'utf8'))
  expect(manifest.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Account', operations: expect.objectContaining({ list: expect.any(Object) }) }),
  ]))
}, 60_000)
