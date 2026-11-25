import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')

it('provides an executable trivia-blueprint that reports the package version', () => {
  const bin = './bin/trivia-blueprint.js'
  const result = spawnSync(path.join(root, bin), ['--version'], { encoding: 'utf8' })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)

  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  expect(manifest.bin).toEqual({ 'trivia-blueprint': bin })
  expect(result.stdout).toBe(`${manifest.version}\n`)
})
