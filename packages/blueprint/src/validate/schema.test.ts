import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadBlueprint } from '../store.js'
import { checkSchema } from './schema.js'

const fixtures = path.resolve(import.meta.dirname, '../../fixtures/invalid/schema_violation')

/** Every file of a fixture directory except expected.json, keyed by its path in the blueprint. */
export function readFixture(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'expected.json') continue
    const full = path.join(entry.parentPath, entry.name)
    files[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8')
  }
  return files
}

describe('schema diagnostics (layer 1, FR-BP-05)', () => {
  const cases = fs.readdirSync(fixtures).sort()

  it('has one fixture per kind of violation', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12)
  })

  for (const name of cases) {
    it(`${name}: points at the violation`, () => {
      const dir = path.join(fixtures, name)
      const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'))
      const bp = loadBlueprint(readFixture(dir))
      const found = Object.values(bp.docs).flatMap((entry) => entry.diagnostics)
      expect(found.map(({ code, doc, pointer }) => ({ code, doc, pointer }))).toEqual(
        expected.map((e: { doc: string; pointer: string }) => ({ code: 'schema_violation', ...e })),
      )
      for (const d of found) expect(d.message.length).toBeGreaterThan(0)
    })
  }

  it('names the missing property and the unknown one in its message', () => {
    const [missing] = checkSchema('app', { $schema: 'https://trivia.dev/schemas/blueprint/app.v1.json', blueprintVersion: 1, name: 'Shop' }, 'app.blueprint.json').diagnostics
    expect(missing).toMatchObject({ pointer: '/targets', message: 'Missing required property "targets"' })
    const [unknown] = checkSchema('model', { $schema: 'https://trivia.dev/schemas/blueprint/model.v1.json', blueprintVersion: 1 }, 'model.blueprint.json').diagnostics
    expect(unknown).toBeUndefined()
  })

  it('never throws, whatever the value', () => {
    for (const value of [null, 42, 'x', [], [1, 2], { kind: null }, { nodes: { a: { b: { c: [] } } } }]) {
      expect(() => checkSchema('page', value, 'pages/X.page.json')).not.toThrow()
      expect(checkSchema('page', value, 'pages/X.page.json').doc).toBeNull()
    }
  })
})
