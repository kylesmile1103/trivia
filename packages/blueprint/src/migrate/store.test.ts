// US4 through the store: an older document is migrated on load and saved at the current
// version by the next write that touches it; a newer one is refused and never written.
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FIXTURES } from '../../test/helpers.js'
import { apply } from '../apply/index.js'
import { sequenceSource } from '../ids.js'
import { loadBlueprint } from '../store.js'
import type { MigrationTable } from './index.js'

const FILE = 'pages/Legacy.page.json'
const v0 = fs.readFileSync(path.join(FIXTURES, 'migrate/v0', FILE), 'utf8')
const v1 = fs.readFileSync(path.join(FIXTURES, 'migrate/v1', FILE), 'utf8')

/** Test only: version 0 called the list's fields `columns`. */
const table: MigrationTable = {
  app: {},
  model: {},
  page: {
    0: (doc) => {
      const { columns, ...options } = (doc.options ?? {}) as { columns?: unknown }
      return { ...doc, options: columns === undefined ? options : { ...options, fields: columns } }
    },
  },
}

describe('migrations on load (T025, US4)', () => {
  it('migrates an older document in memory and keeps the bytes it read', () => {
    const entry = loadBlueprint({ [FILE]: v0 }, { migrations: table }).docs[FILE]
    expect(entry?.diagnostics).toEqual([])
    expect(entry?.migratedFrom).toBe(0)
    expect(entry?.doc).toMatchObject({ blueprintVersion: 1, options: { fields: ['fullName', 'email'] } })
    expect(entry?.text).toBe(v0)
  })

  it('saves it at the current version on the next write that touches it', () => {
    const bp = loadBlueprint({ [FILE]: v0 }, { migrations: table })
    const outcome = apply(bp, [{ op: 'setPageMeta', doc: FILE, baseRev: bp.docs[FILE]?.rev, route: '/legacy' }], { ids: sequenceSource() })
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
    expect(outcome.writes).toEqual([{ file: FILE, before: v0, after: v1 }])
  })

  it('without a migration for its version, refuses it with unsupported_version', () => {
    const entry = loadBlueprint({ [FILE]: v0 }).docs[FILE]
    expect(entry?.doc).toBeNull()
    expect(entry?.diagnostics).toMatchObject([{ code: 'unsupported_version', severity: 'error', doc: FILE, pointer: '/blueprintVersion' }])
  })

  it('refuses a newer document and never writes it, not even to delete it', () => {
    const newer = v1.replace('"blueprintVersion": 1', '"blueprintVersion": 2').replace('page.v1.json', 'page.v2.json')
    const bp = loadBlueprint({ [FILE]: newer })
    const entry = bp.docs[FILE]
    expect(entry?.doc).toBeNull()
    expect(entry?.diagnostics).toMatchObject([{ code: 'unsupported_version', pointer: '/blueprintVersion', message: expect.stringContaining('2') }])
    const ids = sequenceSource()
    for (const op of [
      { op: 'setPageMeta', doc: FILE, baseRev: entry?.rev, public: true },
      { op: 'deletePage', doc: FILE, baseRev: entry?.rev },
    ]) {
      const outcome = apply(bp, [op], { ids })
      expect(outcome.ok ? 'written' : outcome.error.code).toBe('invalid_op')
    }
  })

  it('reports a version that is not a number through the schema, with its pointer', () => {
    const entry = loadBlueprint({ [FILE]: v1.replace('"blueprintVersion": 1', '"blueprintVersion": "1"') }).docs[FILE]
    expect(entry?.diagnostics.map((d) => [d.code, d.pointer])).toEqual([['schema_violation', '/blueprintVersion']])
  })
})
