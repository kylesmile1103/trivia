import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture, renderWrites } from '../../test/helpers.js'
import { sequenceSource } from '../ids.js'
import { loadBlueprint, type Blueprint } from '../store.js'
import { pageDocPath } from '../types/ops.js'
import { apply, type ApplyOutcome } from './index.js'

const files = readFixture(path.join(FIXTURES, 'valid', 'backoffice'))
const overview = pageDocPath('CustomerOverview')
const list = pageDocPath('CustomerList')
const root = 'n_01JDK3M8A00000000000000001'
const title = 'n_01JDK3M8A00000000000000003'
const refresh = 'n_01JDK3M8A00000000000000004'
const summary = 'n_01JDK3M8A00000000000000005'
const customerItem = 'n_01JDK3M8A00000000000000007'
const missing = 'n_01JDK3M8A00000000000000010'
const diffHeader = `--- a/${overview}\n+++ b/${overview}\n`

function target(blueprint: Blueprint, node: string, expectedType: string, doc = overview) {
  return { doc, baseRev: blueprint.docs[doc]?.rev, node, expectedType }
}

function changedPage(outcome: ApplyOutcome, diff: string) {
  if (!outcome.ok) throw new Error(outcome.error.message)
  const entry = outcome.blueprint.docs[overview]
  if (entry?.kind !== 'page' || entry.doc?.kind !== 'custom') throw new Error(`Missing custom page ${overview}`)
  expect(renderWrites(outcome.writes)).toBe(diffHeader + diff)
  return entry.doc
}

describe('value ops', () => {
  it('setProp stores false and preserves the other props', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setProp', ...target(blueprint, refresh, 'Button'), prop: 'disabled', value: false },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `+      "disabled": false,
`)
    expect(page.props[refresh]).toEqual({ children: 'Refresh', disabled: false, variant: 'outline' })
  })

  it('setProp removes only the named static prop on null', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setProp', ...target(blueprint, refresh, 'Button'), prop: 'children', value: null },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `-      "children": "Refresh",
`)
    expect(page.props[refresh]).toEqual({ variant: 'outline' })
  })

  it('setProp refuses a missing node', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setProp', ...target(blueprint, missing, 'Button'), prop: 'disabled', value: true },
    ], { ids: sequenceSource() })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'node_not_found', op: 0 } })
  })

  it('setBinding and setProp move a prop both ways and drop the emptied node entries', () => {
    const blueprint = loadBlueprint(files)
    const bound = apply(blueprint, [
      { op: 'setBinding', ...target(blueprint, title, 'h1'), prop: 'children', expr: 'state.selectedId' },
    ], { ids: sequenceSource() })

    const boundPage = changedPage(bound, `-    "${title}": {
-      "children": "Customers"
-    },
+    "${title}": {
+      "children": "state.selectedId"
+    },
`)
    expect(boundPage.props).not.toHaveProperty(title)
    expect(boundPage.bindings[title]).toEqual({ children: 'state.selectedId' })

    if (!bound.ok) throw new Error(bound.error.message)
    const staticAgain = apply(bound.blueprint, [
      { op: 'setProp', ...target(bound.blueprint, title, 'h1'), prop: 'children', value: 'Customer overview' },
    ], { ids: sequenceSource() })

    const staticPage = changedPage(staticAgain, `+    "${title}": {
+      "children": "Customer overview"
+    },
-    "${title}": {
-      "children": "state.selectedId"
-    },
`)
    expect(staticPage.props[title]).toEqual({ children: 'Customer overview' })
    expect(staticPage.bindings).not.toHaveProperty(title)
  })

  it('setBinding replaces the expression for an existing binding', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setBinding', ...target(blueprint, summary, 'Card'), prop: 'title', expr: 'data.customers.total' },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `-      "title": "\`\${data.customers.total} customers\`"
+      "title": "data.customers.total"
`)
    expect(page.bindings[summary]).toEqual({ title: 'data.customers.total' })
  })

  it('setBinding removes the node entry when null clears its last binding', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setBinding', ...target(blueprint, summary, 'Card'), prop: 'title', expr: null },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `-    "${summary}": {
-      "title": "\`\${data.customers.total} customers\`"
-    },
`)
    expect(page.bindings).not.toHaveProperty(summary)
  })

  it('null prop and binding edits leave the value in the opposite map alone', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setBinding', ...target(blueprint, title, 'h1'), prop: 'children', expr: null },
      { op: 'setProp', ...target(blueprint, summary, 'Card'), prop: 'title', value: null },
    ], { ids: sequenceSource() })

    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(outcome.blueprint.docs[overview]?.doc).toEqual(blueprint.docs[overview]?.doc)
    expect(renderWrites(outcome.writes)).toBe('')
  })

  it('setBinding refuses a mismatched node type', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setBinding', ...target(blueprint, title, 'Button'), prop: 'children', expr: 'state.selectedId' },
    ], { ids: sequenceSource() })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'conflict', op: 0 } })
  })

  it('setStyle replaces the class name', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setStyle', ...target(blueprint, root, 'div'), className: 'grid gap-2' },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `-      "className": "grid gap-4 p-6"
+      "className": "grid gap-2"
`)
    expect(page.styles[root]).toEqual({ className: 'grid gap-2' })
  })

  it.each([
    { label: 'null', className: null },
    { label: 'an empty class name', className: '' },
  ])('setStyle removes the style for $label', ({ className }) => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setStyle', ...target(blueprint, root, 'div'), className },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `-    "${root}": {
-      "className": "grid gap-4 p-6"
-    },
`)
    expect(page.styles).not.toHaveProperty(root)
  })

  it('setStyle refuses a contract page', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setStyle', ...target(blueprint, root, 'div', list), className: 'grid' },
    ], { ids: sequenceSource() })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid_op', op: 0, message: expect.stringContaining('only custom pages') } })
  })

  it('setControl stores the repeat and its condition', () => {
    const blueprint = loadBlueprint(files)
    const control = { when: 'customer.active', each: 'data.customers.data', as: 'customer', key: 'customer.id' }
    const outcome = apply(blueprint, [
      { op: 'setControl', ...target(blueprint, customerItem, 'li'), control },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `+      "when": "customer.active",
`)
    expect(page.control[customerItem]).toEqual(control)
  })

  it('setControl removes the whole entry on null', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setControl', ...target(blueprint, refresh, 'Button'), control: null },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `-    "${refresh}": {
-      "when": "data.customers.total > 0"
-    },
`)
    expect(page.control).not.toHaveProperty(refresh)
  })

  it('setControl refuses a missing node even when clearing an entry', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setControl', ...target(blueprint, missing, 'Button'), control: null },
    ], { ids: sequenceSource() })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'node_not_found', op: 0 } })
  })
})
