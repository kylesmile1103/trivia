import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/shared/engine/client'
import type { BlueprintDocument, BlueprintSummary } from '@/shared/engine/types'

import { createBlueprintStore } from './store'

const path = 'pages/Customers.page.json'
const summary = (rev: string): BlueprintSummary => ({
  dir: 'blueprint', exists: true, app: null, model: null, diagnostics: [], next: '',
  pages: [{ name: 'Customers', path, rev, route: '/customers', kind: 'list', status: 'draft', errors: 0, warnings: 0 }],
})
const doc = (rev: string): BlueprintDocument => ({
  path, rev, doc: {
    $schema: 'page-v1', blueprintVersion: 1, id: 'page', name: 'Customers', route: '/customers',
    kind: 'list', public: false, resource: 'customers', options: { title: rev },
  },
})
const change = { op: 'setPageMeta', doc: path, baseRev: 'old', options: { title: 'Mine' } } as const

describe('blueprint state (FR-DS-07)', () => {
  it('loads the open document and uses the patch response to reload its new revision', async () => {
    const api = {
      summary: vi.fn().mockResolvedValue(summary('old')),
      doc: vi.fn().mockResolvedValueOnce(doc('old')).mockResolvedValueOnce(doc('committed')),
      patch: vi.fn().mockResolvedValue({
        summary: summary('committed'), changed: true, revs: { [path]: 'committed' }, created: {}, diagnostics: [], entry: 'Set title',
      }),
    }
    const store = createBlueprintStore(api)
    await store.getState().refresh()
    await store.getState().open(path)
    expect(store.getState().document?.rev).toBe('old')
    await store.getState().patch([change], 'Set title')
    expect(api.patch).toHaveBeenCalledWith([change], 'Set title')
    expect(store.getState()).toMatchObject({ summary: summary('committed'), document: doc('committed'), pending: null })
  })

  it('reloads the agent revision after a 409 and never retries the patch', async () => {
    const api = {
      summary: vi.fn().mockResolvedValueOnce(summary('old')).mockResolvedValueOnce(summary('agent')),
      doc: vi.fn().mockResolvedValueOnce(doc('old')).mockResolvedValueOnce(doc('agent')),
      patch: vi.fn().mockRejectedValue(new ApiError({ code: 'conflict', message: 'stale revision' }, 409)),
    }
    const store = createBlueprintStore(api)
    await store.getState().refresh()
    await store.getState().open(path)
    await expect(store.getState().patch([change], 'Set title')).resolves.toBeNull()
    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(store.getState()).toMatchObject({
      summary: summary('agent'), document: doc('agent'), pending: null,
      problem: { message: expect.stringMatching(/not applied/i) },
    })
  })

  it('ignores a document read when the user closes it before the result arrives', async () => {
    let resolve: (document: BlueprintDocument) => void = () => {}
    const read = new Promise<BlueprintDocument>((done) => { resolve = done })
    const store = createBlueprintStore({ summary: vi.fn(), doc: vi.fn(() => read), patch: vi.fn() })
    const open = store.getState().open(path)
    await store.getState().open(null)
    resolve(doc('old'))
    await open
    expect(store.getState()).toMatchObject({ path: null, document: null })
  })
})
