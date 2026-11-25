import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture, renderWrites } from '../../test/helpers.js'
import { sequenceSource } from '../ids.js'
import { loadBlueprint, type Blueprint } from '../store.js'
import { APP_DOC } from '../types/ops.js'
import { apply, type ApplyOutcome } from './index.js'

const files = readFixture(path.join(FIXTURES, 'valid', 'backoffice'))
const diffHeader = `--- a/${APP_DOC}\n+++ b/${APP_DOC}\n`

function withoutApp() {
  const pages = { ...files }
  delete pages[APP_DOC]
  return loadBlueprint(pages)
}

function target(blueprint: Blueprint) {
  return { doc: APP_DOC, baseRev: blueprint.docs[APP_DOC]?.rev ?? null }
}

function appFrom(blueprint: Blueprint) {
  const entry = blueprint.docs[APP_DOC]
  if (entry?.kind !== 'app' || !entry.doc) throw new Error(`Missing app document ${APP_DOC}`)
  return entry.doc
}

function changedApp(outcome: ApplyOutcome, diff: string) {
  if (!outcome.ok) throw new Error(outcome.error.message)
  expect(renderWrites(outcome.writes)).toBe(diff)
  return appFrom(outcome.blueprint)
}

describe('app ops', () => {
  it('setApp merges the fields and tokens supplied by the op', () => {
    const blueprint = loadBlueprint(files)
    const before = appFrom(blueprint)
    const outcome = apply(blueprint, [
      {
        op: 'setApp', ...target(blueprint), name: 'CustomerPortal',
        targets: { web: 'next-refine', api: null }, auth: { mode: 'none' },
        theme: { tokens: { primary: null, card: 'oklch(1 0 0)' } },
      },
    ], { ids: sequenceSource() })

    const app = changedApp(outcome, diffHeader + `-  "name": "BackOffice",
+  "name": "CustomerPortal",
-    "web": "vite-refine",
-    "api": "dotnet-minimal"
-  },
-  "auth": {
-    "mode": "oidc"
+    "web": "next-refine"
-      "primary": "oklch(0.21 0.006 285.9)",
+      "card": "oklch(1 0 0)",
`)
    expect(app).toEqual({
      ...before,
      name: 'CustomerPortal',
      targets: { web: 'next-refine' },
      auth: { mode: 'none' },
      theme: { tokens: { card: 'oklch(1 0 0)', radius: '0.5rem' } },
    })
  })

  it('setApp can restore the API target without changing the web target', () => {
    const blueprint = loadBlueprint(files)
    const removed = apply(blueprint, [
      { op: 'setApp', ...target(blueprint), targets: { api: null } },
    ], { ids: sequenceSource() })
    if (!removed.ok) throw new Error(removed.error.message)
    const before = changedApp(removed, diffHeader + `-    "web": "vite-refine",
-    "api": "dotnet-minimal"
+    "web": "vite-refine"
`)
    expect(before.targets).toEqual({ web: 'vite-refine' })

    const restored = apply(removed.blueprint, [
      { op: 'setApp', ...target(removed.blueprint), targets: { api: 'dotnet-minimal' } },
    ], { ids: sequenceSource() })
    const app = changedApp(restored, diffHeader + `-    "web": "vite-refine"
+    "web": "vite-refine",
+    "api": "dotnet-minimal"
`)
    expect(app).toEqual({ ...before, targets: { web: 'vite-refine', api: 'dotnet-minimal' } })
  })

  it('setApp creates the document with optional settings and skips null tokens', () => {
    const blueprint = withoutApp()
    const outcome = apply(blueprint, [
      {
        op: 'setApp', ...target(blueprint), name: 'CustomerPortal',
        targets: { web: 'next-refine', api: 'dotnet-minimal' }, auth: { mode: 'oidc' },
        theme: { tokens: { primary: null, radius: '1rem' } },
      },
    ], { ids: sequenceSource() })

    const app = changedApp(outcome, `--- /dev/null
+++ b/${APP_DOC}
+{
+  "$schema": "https://trivia.dev/schemas/blueprint/app.v1.json",
+  "blueprintVersion": 1,
+  "name": "CustomerPortal",
+  "targets": {
+    "web": "next-refine",
+    "api": "dotnet-minimal"
+  },
+  "auth": {
+    "mode": "oidc"
+  },
+  "theme": {
+    "tokens": {
+      "radius": "1rem"
+    }
+  }
+}
`)
    expect(app).toEqual({
      $schema: 'https://trivia.dev/schemas/blueprint/app.v1.json',
      blueprintVersion: 1,
      name: 'CustomerPortal',
      targets: { web: 'next-refine', api: 'dotnet-minimal' },
      auth: { mode: 'oidc' },
      theme: { tokens: { radius: '1rem' } },
      nav: [],
    })
  })

  it.each([
    { missing: 'name', fields: { targets: { web: 'next-refine' } } },
    { missing: 'targets.web', fields: { name: 'CustomerPortal', targets: { api: 'dotnet-minimal' } } },
  ])('setApp refuses to create a document missing $missing', ({ missing, fields }) => {
    const blueprint = withoutApp()
    const outcome = apply(blueprint, [
      { op: 'setApp', ...target(blueprint), ...fields },
    ], { ids: sequenceSource() })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid_op', op: 0, message: expect.stringContaining(missing) } })
  })

  it('setNav replaces the entire navigation array', () => {
    const blueprint = loadBlueprint(files)
    const nav = [{ page: 'CustomerOverview', label: 'Overview' }]
    const outcome = apply(blueprint, [
      { op: 'setNav', ...target(blueprint), nav },
    ], { ids: sequenceSource() })

    const app = changedApp(outcome, diffHeader + `-      "page": "CustomerList",
-      "label": "Customers",
-      "icon": "users"
-    },
-    {
`)
    expect(app).toEqual({ ...appFrom(blueprint), nav })
  })

  it('setNav clears the navigation when the array is empty', () => {
    const blueprint = loadBlueprint(files)
    const outcome = apply(blueprint, [
      { op: 'setNav', ...target(blueprint), nav: [] },
    ], { ids: sequenceSource() })

    const app = changedApp(outcome, diffHeader + `-  },
-  "nav": [
-    {
-      "page": "CustomerList",
-      "label": "Customers",
-      "icon": "users"
-    },
-    {
-      "page": "CustomerOverview",
-      "label": "Overview"
-    }
-  ]
+  }
`)
    expect(app).toEqual({ ...appFrom(blueprint), nav: [] })
  })

  it('setNav refuses a missing app document', () => {
    const blueprint = withoutApp()
    const outcome = apply(blueprint, [
      { op: 'setNav', ...target(blueprint), nav: [] },
    ], { ids: sequenceSource() })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid_op', op: 0, message: `${APP_DOC} does not exist` } })
  })
})
