import { describe, expect, it } from 'vitest'

import { type Template, insertedLocator, templateOps } from './template'

const at = (path: string) => `src/pages/Home.tsx#Home#${path}`

const TABLE: Template = {
  component: 'DataTable',
  label: 'Customer table',
  snippet: '<DataTable columns={[]} />',
  imports: [{ name: 'DataTable', source: '@/components/data-table' }],
  before: [{ op: 'createFile', file: 'src/components/data-table.tsx', content: 'export function DataTable() {}', ifMissing: true }],
  bind: {
    optionsFn: 'listCustomersOptions',
    optionsImport: '@/api/generated/@tanstack/react-query.gen',
    resource: 'Customer',
    itemsPath: 'items',
    dataProp: 'data',
    loadingProp: 'isLoading',
  },
}

describe('insertedLocator', () => {
  it('is where the insert lands', () => {
    expect(insertedLocator({ target: at('0.2'), expectedName: 'div', placement: 'before', childCount: 0 })).toBe(at('0.2'))
    expect(insertedLocator({ target: at('0.2'), expectedName: 'div', placement: 'after', childCount: 0 })).toBe(at('0.3'))
    expect(insertedLocator({ target: at('0'), expectedName: 'div', placement: 'after', childCount: 0 })).toBe(at('1'))
    expect(insertedLocator({ target: at('0.2'), expectedName: 'div', placement: 'firstChild', childCount: 4 })).toBe(at('0.2.0'))
    expect(insertedLocator({ target: at('0.2'), expectedName: 'div', placement: 'lastChild', childCount: 4 })).toBe(at('0.2.4'))
  })
})

describe('templateOps', () => {
  it('is one insert for a plain template', () => {
    const { before: _b, bind: _x, ...plain } = TABLE
    expect(templateOps(plain, { target: at('0'), expectedName: 'main', placement: 'lastChild', childCount: 1 })).toEqual([
      { op: 'insert', target: at('0'), expectedName: 'main', placement: 'lastChild', snippet: plain.snippet, imports: plain.imports },
    ])
  })

  it('runs `before` first and binds the inserted element last, one batch', () => {
    const ops = templateOps(TABLE, { target: at('0'), expectedName: 'main', placement: 'lastChild', childCount: 2 })
    expect(ops.map((op) => op.op)).toEqual(['createFile', 'insert', 'bindQuery'])
    expect(ops[2]).toEqual({ op: 'bindQuery', target: at('0.2'), expectedName: 'DataTable', ...TABLE.bind })
  })
})
