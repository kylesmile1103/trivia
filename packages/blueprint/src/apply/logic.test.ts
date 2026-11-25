import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture, renderWrites } from '../../test/helpers.js'
import { sequenceSource } from '../ids.js'
import { loadBlueprint, type Blueprint } from '../store.js'
import { APP_DOC, pageDocPath } from '../types/ops.js'
import { apply, type ApplyOutcome } from './index.js'

const files = readFixture(path.join(FIXTURES, 'valid', 'backoffice'))
const overview = pageDocPath('CustomerOverview')
const list = pageDocPath('CustomerList')
const refresh = 'n_01JDK3M8A00000000000000004'
const click = `${refresh}.onClick`
const diffHeader = `--- a/${overview}\n+++ b/${overview}\n`

function target(blueprint: Blueprint, doc = overview) {
  return { doc, baseRev: blueprint.docs[doc]?.rev }
}

function changedPage(outcome: ApplyOutcome, diff: string) {
  if (!outcome.ok) throw new Error(outcome.error.message)
  const entry = outcome.blueprint.docs[overview]
  if (entry?.kind !== 'page' || entry.doc?.kind !== 'custom') throw new Error(`Missing custom page ${overview}`)
  expect(renderWrites(outcome.writes)).toBe(diffHeader + diff)
  return entry.doc
}

describe('logic ops', () => {
  it('setState creates state under a free name', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setState', ...target(blueprint), name: 'loading', type: 'boolean', initial: false },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `+    "loading": {
+      "type": "boolean",
+      "initial": false
+    },
`)
    expect(page.state.loading).toEqual({ type: 'boolean', initial: false })
  })

  it('setState replaces an existing state entry', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setState', ...target(blueprint), name: 'selectedId', type: 'string', initial: 'cust-1' },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `-      "type": "string | null",
-      "initial": null
+      "type": "string",
+      "initial": "cust-1"
`)
    expect(page.state.selectedId).toEqual({ type: 'string', initial: 'cust-1' })
  })

  it.each(['refresh', 'customers'])('setState refuses the taken name %s', (name) => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setState', ...target(blueprint), name, type: 'string', initial: '' },
    ], { ids: sequenceSource() })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'conflict', op: 0, details: { name } } })
  })

  it('setState refuses a contract page', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setState', ...target(blueprint, list), name: 'loading', type: 'boolean', initial: false },
    ], { ids: sequenceSource() })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid_op', op: 0, message: expect.stringContaining('only custom pages') } })
  })

  it('removeState deletes the named state entry', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'removeState', ...target(blueprint), name: 'filters' },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `-    "filters": {
-      "type": "{ status: string }",
-      "initial": {
-        "status": "active"
-      }
-    },
`)
    expect(page.state).toEqual({ selectedId: { type: 'string | null', initial: null } })
  })

  it('removeState refuses a name without a state entry', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'removeState', ...target(blueprint), name: 'constructor' },
    ], { ids: sequenceSource() })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid_op', op: 0, details: { name: 'constructor' } } })
  })

  it('setQuery creates a query with the default params', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setQuery', ...target(blueprint), name: 'allCustomers', query: { kind: 'list', resource: 'Customer' } },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `+    "allCustomers": {
+      "kind": "list",
+      "resource": "Customer"
+    },
`)
    expect(page.queries.allCustomers).toEqual({ kind: 'list', resource: 'Customer', params: {} })
  })

  it('setQuery replaces the whole query when its kind changes', () => {
    const blueprint = loadBlueprint(files)
    const query = { kind: 'one', resource: 'Customer', params: { id: 'state.selectedId' } } as const
    const outcome = apply(blueprint, [
      { op: 'setQuery', ...target(blueprint), name: 'stats', query },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `-      "kind": "custom",
+      "kind": "one",
-      "operation": "customerStats"
+      "params": {
+        "id": "state.selectedId"
+      }
`)
    expect(page.queries.stats).toEqual(query)
  })

  it.each(['refresh', 'selectedId'])('setQuery refuses the taken name %s', (name) => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setQuery', ...target(blueprint), name, query: { kind: 'list', resource: 'Customer' } },
    ], { ids: sequenceSource() })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'conflict', op: 0, details: { name } } })
  })

  it('removeQuery deletes the named query', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'removeQuery', ...target(blueprint), name: 'stats' },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `-    },
-    "stats": {
-      "kind": "custom",
-      "resource": "Customer",
-      "operation": "customerStats"
`)
    expect(Object.keys(page.queries)).toEqual(['customers', 'selected'])
  })

  it('removeQuery refuses a name without a query entry', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'removeQuery', ...target(blueprint), name: 'constructor' },
    ], { ids: sequenceSource() })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid_op', op: 0, details: { name: 'constructor' } } })
  })

  it('setActions replaces the steps for the specified node and event', () => {
    const blueprint = loadBlueprint(files)
    const steps = [{ do: 'refetch', query: 'stats' }, { do: 'toast', message: "'Stats refreshed'", variant: 'success' }]
    const outcome = apply(blueprint, [
      { op: 'setActions', ...target(blueprint), node: refresh, expectedType: 'Button', event: 'onClick', steps },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `-        "query": "customers"
+        "query": "stats"
-        "message": "'Refreshed'"
+        "message": "'Stats refreshed'",
+        "variant": "success"
`)
    expect(page.actions[click]).toEqual(steps)
  })

  it('setActions removes the event entry when the list is empty', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setActions', ...target(blueprint), node: refresh, expectedType: 'Button', event: 'onClick', steps: [] },
    ], { ids: sequenceSource() })

    const page = changedPage(outcome, `-    "${click}": [
-      {
-        "do": "refetch",
-        "query": "customers"
-      },
-      {
-        "do": "toast",
-        "message": "'Refreshed'"
-      }
-    ],
`)
    expect(page.actions).not.toHaveProperty([click])
  })

  it('setActions refuses a mismatched node type even when clearing an event', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setActions', ...target(blueprint), node: refresh, expectedType: 'Card', event: 'onClick', steps: [] },
    ], { ids: sequenceSource() })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'conflict', op: 0 } })
  })

  it('a name taken earlier in the batch refuses the batch without writes', () => {
    const blueprint = loadBlueprint(files)
    const before = structuredClone(blueprint)
    const outcome = apply(blueprint, [
      { op: 'setApp', ...target(blueprint, APP_DOC), name: 'Renamed' },
      { op: 'setState', ...target(blueprint), name: 'loading', type: 'boolean', initial: false },
      { op: 'setQuery', ...target(blueprint), name: 'loading', query: { kind: 'list', resource: 'Customer' } },
    ], { ids: sequenceSource() })

    expect(outcome).toStrictEqual({
      ok: false,
      error: expect.objectContaining({ code: 'conflict', op: 2, details: { name: 'loading' } }),
    })
    expect(blueprint).toEqual(before)
  })
})
