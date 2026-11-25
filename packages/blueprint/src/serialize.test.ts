import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { rev, revOfText, serialize } from './serialize.js'
import { appSchema } from './types/app.js'
import { SCHEMA_URL } from './types/common.js'
import { modelSchema } from './types/model.js'
import { pageSchema } from './types/page.js'

const fixture = path.resolve(import.meta.dirname, '../fixtures/valid/backoffice')
const files = ['app.blueprint.json', 'pages/CustomerList.page.json', 'pages/CustomerOverview.page.json']
const read = (file: string) => fs.readFileSync(path.join(fixture, file), 'utf8')
const parse = (file: string, value: unknown) => (file.startsWith('pages/') ? pageSchema : appSchema).parse(value)

/** The same JSON with every object's keys reversed, at every depth. */
function shuffle(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffle)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, shuffle(v)]))
}

const page = (extra: Record<string, unknown>) =>
  pageSchema.parse({
    $schema: SCHEMA_URL.page,
    blueprintVersion: 1,
    id: 'pg_01JDK3M6A00000000000000001',
    name: 'Overview',
    route: '/overview',
    kind: 'custom',
    root: 'n_01JDK3M8A00000000000000001',
    nodes: { n_01JDK3M8A00000000000000001: { type: 'div', name: 'page', parent: null, slot: null, order: 'a0' } },
    ...extra,
  })

describe('canonical serialization (FR-BP-04, SC-001)', () => {
  it('saves every fixture document to identical bytes', () => {
    for (const file of files) {
      const text = read(file)
      expect([file, serialize(parse(file, JSON.parse(text)))]).toEqual([file, text])
    }
  })

  it('writes the canonical bytes whatever the key order', () => {
    for (const file of files) {
      const text = read(file)
      expect([file, serialize(parse(file, shuffle(JSON.parse(text))))]).toEqual([file, text])
    }
  })

  it('omits properties equal to their default, so a new default never rewrites a file', () => {
    const list = pageSchema.parse({
      $schema: SCHEMA_URL.page, blueprintVersion: 1, id: 'pg_01JDK3M6A00000000000000001', name: 'CustomerList',
      route: '/customers', kind: 'list', resource: 'Customer', public: false, options: {},
    })
    expect(JSON.parse(serialize(list))).toEqual({
      $schema: SCHEMA_URL.page, blueprintVersion: 1, id: 'pg_01JDK3M6A00000000000000001', name: 'CustomerList',
      route: '/customers', kind: 'list', resource: 'Customer',
    })
    const app = appSchema.parse({
      $schema: SCHEMA_URL.app, blueprintVersion: 1, name: 'Shop', targets: { web: 'vite-refine' },
      auth: { mode: 'none' }, theme: { tokens: {} }, nav: [],
    })
    expect(Object.keys(JSON.parse(serialize(app)))).toEqual(['$schema', 'blueprintVersion', 'name', 'targets'])
    const custom = page({ props: {}, queries: { rows: { kind: 'list', resource: 'Customer', params: {} } } })
    expect(Object.keys(JSON.parse(serialize(custom)))).toEqual([
      '$schema', 'blueprintVersion', 'id', 'name', 'route', 'kind', 'root', 'nodes', 'queries',
    ])
    expect(serialize(custom)).toContain('"rows": {\n      "kind": "list",\n      "resource": "Customer"\n    }')
    expect(serialize(page({ public: true }))).toContain('"public": true')
  })

  it('uses two-space indentation, LF line ends and one final newline', () => {
    for (const file of files) {
      const text = serialize(parse(file, JSON.parse(read(file))))
      expect(text.endsWith('}\n')).toBe(true)
      expect(text.endsWith('\n\n')).toBe(false)
      expect(text).not.toMatch(/\r|\t/)
      expect(text.split('\n')[1]).toMatch(/^ {2}"\$schema"/)
    }
  })

  it('sorts the keys of free JSON bytewise, integer-like keys included, and keeps array order', () => {
    const text = serialize(page({
      props: { n_01JDK3M8A00000000000000001: { data: { b: [3, 1, 2], a: { '2': 'two', '10': 'ten', Z: 0 } } } },
    }))
    const value = '{\n        "a": {\n          "10": "ten",\n          "2": "two",\n          "Z": 0\n        },\n' +
      '        "b": [\n          3,\n          1,\n          2\n        ]\n      }'
    expect(text).toContain(`"data": ${value}`)
  })

  it('keeps the model document as written after its envelope', () => {
    const model = modelSchema.parse({ namespace: 'Shop', blueprintVersion: 1, $schema: SCHEMA_URL.model, enums: [] })
    expect(serialize(model)).toBe(
      `{\n  "$schema": "${SCHEMA_URL.model}",\n  "blueprintVersion": 1,\n  "namespace": "Shop",\n  "enums": []\n}\n`,
    )
  })
})

describe('revisions', () => {
  it('is sha256 of the serialized bytes, equal for equal documents', () => {
    const doc = parse(files[2] as string, JSON.parse(read(files[2] as string)))
    const again = parse(files[2] as string, shuffle(JSON.parse(read(files[2] as string))))
    expect(rev(doc)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(rev(doc)).toBe(rev(again))
    expect(rev(doc)).toBe(revOfText(read(files[2] as string)))
    expect(rev(page({}))).not.toBe(rev(page({ public: true })))
  })
})
