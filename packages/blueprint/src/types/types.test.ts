import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { isOrderKey, keysBetween } from '../order.js'
import { appSchema } from './app.js'
import { NAME, NODE_ID, ORDER_KEY, PAGE_ID, PAGE_NAME, ROUTE } from './common.js'
import { modelSchema } from './model.js'
import { pageSchema } from './page.js'

const fixture = path.resolve(import.meta.dirname, '../../fixtures/valid/backoffice')
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(fixture, file), 'utf8'))

const listPage = {
  $schema: 'https://trivia.dev/schemas/blueprint/page.v1.json',
  blueprintVersion: 1,
  id: 'pg_01JDK3M6A00000000000000001',
  name: 'CustomerList',
  route: '/customers',
  kind: 'list',
  resource: 'Customer',
}
const customPage = {
  ...listPage,
  name: 'Overview',
  kind: 'custom',
  root: 'n_01JDK3M8A00000000000000001',
  nodes: {
    n_01JDK3M8A00000000000000001: { type: 'div', name: 'page', parent: null, slot: null, order: 'a0' },
  },
}

describe('document schemas (FR-BP-01, FR-BP-02, FR-BP-09)', () => {
  it('accepts the backoffice fixture', () => {
    expect(appSchema.safeParse(readJson('app.blueprint.json')).success).toBe(true)
    expect(pageSchema.safeParse(readJson('pages/CustomerList.page.json')).success).toBe(true)
    expect(pageSchema.safeParse(readJson('pages/CustomerOverview.page.json')).success).toBe(true)
  })

  it('accepts a list page with only a resource, and fills the defaults', () => {
    const page = pageSchema.parse(listPage)
    expect(page).toMatchObject({ kind: 'list', public: false, options: {} })
  })

  it('fills empty maps on a custom page and the app defaults', () => {
    const page = pageSchema.parse(customPage)
    if (page.kind !== 'custom') throw new Error('expected a custom page')
    expect(page.props).toEqual({})
    expect(page.actions).toEqual({})
    const app = appSchema.parse({
      $schema: 'https://trivia.dev/schemas/blueprint/app.v1.json',
      blueprintVersion: 1,
      name: 'Shop',
      targets: { web: 'next-refine' },
    })
    expect(app).toMatchObject({ auth: { mode: 'none' }, theme: { tokens: {} }, nav: [] })
  })

  it('refuses nodes on a contract page and a custom page without a root', () => {
    expect(pageSchema.safeParse({ ...listPage, nodes: {} }).success).toBe(false)
    const { root: _root, ...rootless } = customPage
    expect(pageSchema.safeParse(rootless).success).toBe(false)
  })

  it('refuses unknown properties, versions and schema URLs', () => {
    expect(pageSchema.safeParse({ ...listPage, colour: 'red' }).success).toBe(false)
    expect(pageSchema.safeParse({ ...listPage, blueprintVersion: 2 }).success).toBe(false)
    expect(pageSchema.safeParse({ ...listPage, $schema: 'https://example.com/page.json' }).success).toBe(false)
  })

  it('needs each, as and key together in a repeat', () => {
    const control = (entry: unknown) =>
      pageSchema.safeParse({ ...customPage, control: { n_01JDK3M8A00000000000000001: entry } }).success
    expect(control({ when: 'state.open' })).toBe(true)
    expect(control({ each: 'data.rows.data', as: 'row', key: 'row.id' })).toBe(true)
    expect(control({ when: 'state.open', each: 'data.rows.data', as: 'row', key: 'row.id' })).toBe(true)
    expect(control({ each: 'data.rows.data', as: 'row' })).toBe(false)
    expect(control({})).toBe(false)
  })

  it('reads the model document as an envelope until spec 008 defines it', () => {
    const model = { $schema: 'https://trivia.dev/schemas/blueprint/model.v1.json', blueprintVersion: 1, namespace: 'Shop' }
    expect(modelSchema.parse(model)).toEqual(model)
    expect(modelSchema.safeParse({ ...model, blueprintVersion: '1' }).success).toBe(false)
  })
})

describe('id and name patterns (FR-BP-03)', () => {
  it('ids are a prefix and a ULID', () => {
    expect(PAGE_ID.test('pg_01JDK3M7Q2X8Y4Z6A1B3C5D7E9')).toBe(true)
    expect(NODE_ID.test('n_01JDK3M8A00000000000000001')).toBe(true)
    for (const bad of ['n_01JDK3M8A0000000000000000', 'n_01jdk3m8a00000000000000001', 'x_01JDK3M8A00000000000000001',
      'n_01JDK3M8I00000000000000001', 'n_81JDK3M8A00000000000000001', 'pg_01JDK3M8A00000000000000001x']) {
      expect([bad, NODE_ID.test(bad) || PAGE_ID.test(bad)]).toEqual([bad, false])
    }
  })

  it('names are camelCase identifiers that are not reserved words; page names are PascalCase', () => {
    for (const good of ['page', 'refresh', 'customerList', 'x1']) expect([good, NAME.test(good)]).toEqual([good, true])
    for (const bad of ['Refresh', '1x', 'customer_list', 'class', 'new', 'delete', '']) {
      expect([bad, NAME.test(bad)]).toEqual([bad, false])
    }
    expect(PAGE_NAME.test('CustomerOverview')).toBe(true)
    expect(PAGE_NAME.test('customerOverview')).toBe(false)
  })

  it('order keys are fractional index keys', () => {
    for (const good of ['a0', 'a1', 'az', 'b00', 'a0V', 'Zz', 'z' + '0'.repeat(26)]) {
      expect([good, ORDER_KEY.test(good)]).toEqual([good, true])
    }
    for (const bad of ['a', 'a00', 'a0V0', 'b0', '0a', 'a-1', '']) expect([bad, ORDER_KEY.test(bad)]).toEqual([bad, false])
  })

  it('the schema pattern for order keys agrees with isOrderKey (order.ts)', () => {
    const keys = [
      ...keysBetween(null, null, 300), ...keysBetween(null, 'a0', 300), ...keysBetween('a0', 'a1', 300),
      'A' + '0'.repeat(26), 'A' + '0'.repeat(26) + 'V', 'a', 'a00', 'b0', 'zz', '0a', 'a0V0', '', 'Zz',
    ]
    for (const key of keys) expect([key, ORDER_KEY.test(key)]).toEqual([key, isOrderKey(key)])
  })

  it('routes are absolute paths with optional :params', () => {
    for (const good of ['/', '/customers', '/customers/:id/edit', '/a.b/c-d_e~f']) {
      expect([good, ROUTE.test(good)]).toEqual([good, true])
    }
    for (const bad of ['customers', '/customers/', '/a//b', '/:1d', '/a b']) expect([bad, ROUTE.test(bad)]).toEqual([bad, false])
  })
})
