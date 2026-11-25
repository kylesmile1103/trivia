import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import { pageSchema } from '../types/page.js'
import { MIGRATIONS, migrate } from './index.js'
import type { Migration, MigrationTable } from './index.js'

function readLegacy(version: number): unknown {
  const file = new URL(`../../fixtures/migrate/v${version}/pages/Legacy.page.json`, import.meta.url)
  return JSON.parse(readFileSync(file, 'utf8'))
}

const migrateColumns: Migration = (doc) => {
  const options = doc.options
  if (typeof options !== 'object' || options === null || !('columns' in options)) {
    throw new Error('Legacy page is missing options.columns')
  }
  const { columns, ...rest } = options
  return { ...doc, options: { ...rest, fields: columns } }
}

const table: MigrationTable = { app: {}, page: { 0: migrateColumns }, model: {} }

describe('migrate', () => {
  it('migrates the legacy fixture to the expected v1 document', () => {
    const expected = readLegacy(1)
    expect(pageSchema.safeParse(expected).success).toBe(true)

    const result = migrate('page', readLegacy(0), { table })
    expect(result).toMatchObject({ ok: true, from: 0, migrated: true })
    if (!result.ok) throw new Error(result.message)
    expect(JSON.stringify(result.doc)).toBe(JSON.stringify(expected))
  })

  it('deep-clones the input before passing it to a migration', () => {
    const input = { blueprintVersion: 0, options: { columns: ['email'] } }
    const step = vi.fn(migrateColumns)
    const result = migrate('page', input, { table: { ...table, page: { 0: step } } })

    expect(result).toMatchObject({ ok: true, doc: { blueprintVersion: 1, options: { fields: ['email'] } } })
    expect(step).toHaveBeenCalledTimes(1)
    const firstArg = step.mock.calls[0]?.[0]
    expect(firstArg).toEqual(input)
    expect(firstArg).not.toBe(input)
    expect(firstArg?.options).not.toBe(input.options)
    expect(input).toEqual({ blueprintVersion: 0, options: { columns: ['email'] } })
  })

  it('updates both version markers before the next migration runs', () => {
    const secondStep = vi.fn<Migration>((doc) => ({ ...doc, name: 'Updated' }))
    const result = migrate('page', readLegacy(0), {
      table: { ...table, page: { 0: migrateColumns, 1: secondStep } },
      current: 2,
    })
    expect(secondStep).toHaveBeenCalledExactlyOnceWith(readLegacy(1))
    expect(result).toMatchObject({
      ok: true,
      doc: {
        $schema: 'https://trivia.dev/schemas/blueprint/page.v2.json',
        blueprintVersion: 2,
        name: 'Updated',
      },
      from: 0,
      migrated: true,
    })
  })

  it('preserves a schema URL without the outgoing version suffix', () => {
    const input = { blueprintVersion: 0, $schema: 'https://example.com/model.v0.json?draft=true' }
    const result = migrate('model', input, { table: { ...table, model: { 0: (doc) => ({ ...doc }) } } })
    expect(result).toEqual({ ok: true, doc: { ...input, blueprintVersion: 1 }, from: 0, migrated: true })
  })

  it('refuses a newer version and names both versions', () => {
    expect(migrate('page', { blueprintVersion: 5 })).toMatchObject({
      ok: false, code: 'unsupported_version', message: expect.stringMatching(/5.*1/),
    })
  })

  it('refuses a gap in the migration table and names the missing step', () => {
    expect(migrate('page', readLegacy(0), { table, current: 3 })).toMatchObject({
      ok: false, code: 'unsupported_version', message: expect.stringMatching(/1.*2/),
    })
  })

  it('reports a throwing migration with its error message', () => {
    const fail: Migration = () => { throw new Error('missing columns') }
    expect(migrate('page', readLegacy(0), { table: { ...table, page: { 0: fail } } })).toMatchObject({
      ok: false, code: 'schema_violation', message: expect.stringContaining('missing columns'),
    })
  })

  it('rejects non-object document envelopes', () => {
    const dateWithVersion = Object.assign(new Date(0), { blueprintVersion: 1 })
    const arrayWithVersion = Object.assign(Object.setPrototypeOf([], null), { blueprintVersion: 1 })
    for (const input of [null, undefined, 'document', 1, [], dateWithVersion, arrayWithVersion]) {
      expect(migrate('app', input)).toMatchObject({
        ok: false, code: 'schema_violation', message: expect.stringContaining('object'),
      })
    }
  })

  it('rejects missing or invalid blueprintVersion values', () => {
    const inputs = [{}, ...[undefined, '1', -1, 0.5, NaN, Infinity].map((blueprintVersion) => ({ blueprintVersion }))]
    for (const doc of inputs) {
      expect(migrate('app', doc)).toMatchObject({
        ok: false, code: 'schema_violation', message: expect.stringContaining('blueprintVersion'),
      })
    }
  })

  it('returns a current document by reference', () => {
    const otherRealm: unknown = runInNewContext('JSON.parse(\'{"blueprintVersion":1}\')')
    for (const input of [readLegacy(1), otherRealm]) {
      const result = migrate('page', input)
      expect(result).toMatchObject({ ok: true, from: 1, migrated: false })
      if (!result.ok) throw new Error(result.message)
      expect(result.doc).toBe(input)
    }
  })

  it('ships an empty migration table for each document kind', () => {
    expect(MIGRATIONS).toEqual({ app: {}, page: {}, model: {} })
  })
})
