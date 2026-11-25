import path from 'node:path'

import { analyzeExpressions } from '@trivia/engine'
import { describe, expect, it, vi } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import {
  apply, customPageSchema, expressionCheck, expressionRequest, loadBlueprint, sequenceSource, validate,
  type CustomPage,
} from '../index.js'

const DOC = 'pages/CustomerOverview.page.json'
const CARD = 'n_01JDK3M8A00000000000000005'
const LIST = 'n_01JDK3M8A00000000000000006'
const ITEM = 'n_01JDK3M8A00000000000000007'
const TITLE = `/bindings/${CARD}/title`
const files = readFixture(path.join(FIXTURES, 'valid/backoffice'))
const scopeFromManifests = () => ({ tier: 'client' as const, members: { refresh: ['value'] }, types: { refresh: { value: 'string' } } })

function page(): CustomPage {
  const value = customPageSchema.parse(JSON.parse(files[DOC]!))
  value.route = '/customers/:id'
  value.control[ITEM] = { as: 'customer', each: 'data.customers.items', key: 'customer.id', when: 'customer.active' }
  value.queries.customers!.params = { id: 'params.id' }
  return value
}

const blueprint = (value: CustomPage) => loadBlueprint({ ...files, [DOC]: JSON.stringify(value) })
const expressions = expressionCheck(analyzeExpressions, scopeFromManifests)

describe('FR-EX-01 through FR-EX-05: expression validation through the Blueprint context', () => {
  it.each([
    ['state.selectedId = 1', 'expr_unsupported_syntax', 0, 20, 'error'],
    ["'😀' + stat.count", 'expr_unknown_root', 7, 11, 'error'],
    ['ui.refresh.missing', 'expr_unknown_member', 11, 18, 'error'],
    ['fetch("/x")', 'expr_impure_call', 0, 5, 'error'],
    [' '.repeat(4097), 'expr_too_large', 0, 4097, 'error'],
    ['[1].map(state => state.x)', 'expr_shadowed_root', 8, 13, 'warning'],
  ])('maps %s to its document, pointer and UTF-16 span', (source, code, start, end, severity) => {
    const value = page()
    value.bindings[CARD] = { title: source }
    expect(validate(blueprint(value), { expressions })).toMatchObject([
      { code, severity, doc: DOC, pointer: TITLE, span: { start, end, unit: 'utf16' } },
    ])
  })

  it('derives each alias and index tiers from their source and scopes aliases to the subtree', () => {
    const value = page()
    value.control[LIST] = { as: 'group', each: 'data.customers.items', key: 'group.id' }
    value.control[ITEM] = { as: 'customer', each: 'group.members', key: 'customer.id' }
    value.bindings[CARD] = { title: 'ui.refresh.value + data.selected.record.name + search.term + user.id' }
    value.bindings[ITEM] = { children: '`row ${index} ${customer.fullName}`' }
    const result = JSON.parse(analyzeExpressions(JSON.stringify(expressionRequest(value, scopeFromManifests()))))
    expect(result.ok).toBe(true)
    expect(result.data.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `/bindings/${ITEM}/children`, ok: true, tier: 'server', deps: [] }),
      expect.objectContaining({ id: `/actions/${ITEM}.onClick/0/value`, ok: true, tier: 'server', deps: [] }),
      expect.objectContaining({ id: TITLE, ok: true, tier: 'client', deps: ['ui.refresh', 'data.selected', 'search.term', 'user.id'] }),
    ]))
    expect(validate(blueprint(value), { expressions })).toEqual([])
    value.bindings[CARD] = { title: 'customer.fullName' }
    expect(validate(blueprint(value), { expressions })).toMatchObject([{ code: 'expr_unknown_root', pointer: TITLE }])
  })

  it('reports query cycles on the participating expressions and keeps draft changes', () => {
    const value = page()
    value.queries.customers!.params.id = 'data.selected.record.id'
    value.queries.selected!.params.id = 'data.customers.items[0].id'
    const doc = blueprint(value)
    expect(validate(doc, { expressions }).map(({ code, pointer, message }) => [code, pointer, message])).toEqual([
      ['expr_cycle', '/queries/customers/params/id', expect.stringContaining('data.customers -> data.selected -> data.customers')],
      ['expr_cycle', '/queries/selected/params/id', expect.stringContaining('data.customers -> data.selected -> data.customers')],
    ])
    const result = apply(doc, [{ op: 'setBinding', doc: DOC, baseRev: doc.docs[DOC]?.rev,
      node: CARD, expectedType: 'Card', prop: 'title', expr: 'missing.value' }], { ids: sequenceSource(), ctx: { expressions } })
    expect(result.ok && result.result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'expr_unknown_root', pointer: TITLE }),
    ]))
  })

  it('uses row and event locals in contract actions and skips pages with earlier errors', () => {
    const contractDoc = 'pages/CustomerList.page.json'
    const value = JSON.parse(files[contractDoc]!)
    value.options.rowActions = [{ name: 'open', label: 'Open', steps: [{ do: 'navigate', to: 'String(row.id) + event.type' }] }]
    const call = vi.fn(analyzeExpressions)
    const input = loadBlueprint({ ...files, [contractDoc]: JSON.stringify(value) })
    expect(validate(input, {
      manifests: () => [{ code: 'missing_component', severity: 'error', doc: DOC, pointer: '', message: 'Missing' }],
      expressions: expressionCheck(call, scopeFromManifests),
    })).toMatchObject([{ code: 'missing_component' }])
    expect(call).toHaveBeenCalledTimes(1)
    const request = call.mock.calls[0]?.[0]
    expect(JSON.parse(request!).expressions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '/options/rowActions/0/steps/0/to', locals: { row: 'client', event: 'client' } }),
    ]))
  })
})
