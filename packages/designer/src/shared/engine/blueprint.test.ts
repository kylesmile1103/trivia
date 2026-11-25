import { afterEach, describe, expect, it, vi } from 'vitest'

import { engine } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('Blueprint HTTP client (FR-DS-01, FR-DS-04, FR-DS-06, FR-DS-07)', () => {
  it('uses the blueprint routes and encodes document paths', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true, data: { marker: 'result' } }))
    vi.stubGlobal('fetch', fetch)
    const ops = [{ op: 'deletePage', doc: 'pages/Customers.page.json', baseRev: 'rev' }] as const
    await expect(engine.blueprint.summary()).resolves.toEqual({ marker: 'result' })
    await engine.blueprint.doc('pages/Customers & Orders.page.json', true)
    await engine.blueprint.components()
    await engine.blueprint.patch([...ops], 'Delete customers page')
    await engine.blueprint.preview('Customers')
    await engine.blueprint.plan(['Customers'])
    await engine.blueprint.ejected(['Customers'], 'Eject Customers')
    await engine.blueprint.backend({ mode: 'plan' })
    expect(fetch.mock.calls).toEqual([
      ['/@trivia/api/blueprint', undefined],
      ['/@trivia/api/blueprint/doc?path=pages%2FCustomers%20%26%20Orders.page.json&projection=1', undefined],
      ['/@trivia/api/blueprint/components', undefined],
      ...[
        ['/patch', { ops, label: 'Delete customers page' }],
        ['/preview', { page: 'Customers' }],
        ['/plan', { pages: ['Customers'] }],
        ['/ejected', { pages: ['Customers'], entry: 'Eject Customers' }],
        ['/backend', { mode: 'plan' }],
      ].map(([route, body]) => ['/@trivia/api/blueprint' + route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }]),
    ])
  })

  it('preserves structured refusals for the panel', async () => {
    const error = { code: 'unresolved_component', message: 'Missing items', details: { requires: [{ item: 'card', registry: 'shadcn' }] } }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, error }, { status: 422 })))
    await expect(engine.blueprint.plan()).rejects.toMatchObject({ ...error, status: 422 })
  })
})
