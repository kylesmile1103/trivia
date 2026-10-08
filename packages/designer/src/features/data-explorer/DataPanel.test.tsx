// @vitest-environment jsdom
//
// The Data tab over a stubbed GET /manifest: the empty state, the drift badge, and actions that
// say why they are unavailable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManifestState, TriviaManifest } from '@/shared/engine/types'
import { type Mounted, mount, settle } from '@/shared/lib/test-utils'
import { designer } from '@/shared/state/store'

import { DataPanel } from './DataPanel'

const manifestState = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/shared/engine/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/shared/engine/client')>()
  return { ...real, engine: { ...real.engine, manifest: async () => manifestState.current } }
})

const MANIFEST = {
  source: { location: 'openapi/shop.json', title: 'Shop API' },
  schemaHash: 'sha256:a',
  modules: { outputDir: 'src/api/generated', queries: { file: 'src/api/generated/q.ts', importPath: '@/api/generated/q' }, zod: null },
  resources: [
    {
      name: 'Order',
      primaryKey: 'id',
      entity: { fields: [{ name: 'id', type: 'string', format: null, required: true, nullable: false, readOnly: true, enum: null, description: null }, { name: 'total', type: 'number', format: null, required: true, nullable: false, readOnly: false, enum: null, description: null }] },
      operations: {
        list: { kind: 'list', method: 'GET', path: '/orders', summary: null, sdkFn: 'listOrders', queryOptionsFn: 'listOrdersOptions', queryKeyFn: 'listOrdersQueryKey', mutationFn: null, requestBody: null, listItemsPath: null },
        get: null,
        create: { kind: 'create', method: 'POST', path: '/orders', summary: null, sdkFn: 'createOrder', queryOptionsFn: null, queryKeyFn: null, mutationFn: 'createOrderMutation', requestBody: { required: true, contentType: 'application/json', fields: [], zodSchema: null } },
        update: null,
        delete: null,
      },
      customOperations: [],
    },
  ],
} as unknown as TriviaManifest

let ui: Mounted | null = null

beforeEach(() => {
  designer.setState({ health: { root: '/app', uiDir: 'src/components/ui', importBase: '@/components/ui', version: 't' }, componentsByName: {} })
})
afterEach(async () => {
  await ui?.unmount()
  ui = null
})

async function show(state: ManifestState) {
  manifestState.current = state
  ui = await mount(<DataPanel />)
  await settle()
}

describe('the Data tab', () => {
  it('explains how to get a manifest when the project has none', async () => {
    await show({ manifest: null, drift: null })
    expect(document.body.textContent).toContain('This project has no trivia.manifest.json yet.')
    expect(document.body.textContent).toContain('trivia-contract-sync --input openapi.json --zod')
  })

  it('names the API, and flags a spec that changed since the code was generated', async () => {
    await show({ manifest: MANIFEST, drift: { status: 'changed', source: 'openapi/shop.json', manifestHash: 'sha256:a', specHash: 'sha256:b' } })
    expect(document.body.textContent).toContain('Shop API')
    expect(document.body.textContent).toContain('Spec changed')
  })

  it('shows no badge when the spec is current', async () => {
    await show({ manifest: MANIFEST, drift: { status: 'current', source: 'openapi/shop.json', manifestHash: 'sha256:a', specHash: 'sha256:a' } })
    expect(document.body.textContent).not.toContain('Spec changed')
  })

  it('offers a table for a list operation, and disables a form it can’t generate', async () => {
    await show({ manifest: MANIFEST, drift: null })
    const order = document.querySelector('[aria-label="Order"]')!
    expect(order.textContent).toContain('list')
    expect(order.textContent).toContain('create')
    const table = order.querySelector<HTMLButtonElement>('[data-data-template="Order table"]')!
    expect(table.disabled).toBe(false)
    expect(table.draggable).toBe(true)
    const form = [...order.querySelectorAll('button')].find((b) => b.textContent?.includes('Create form'))!
    expect(form.disabled).toBe(true)
  })
})
