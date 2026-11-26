// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { isHydrated, isRouterRequest, refreshRouter, whenHydrated } from './next-hydration'

const page = new URL('http://localhost:4402/customers?page=2') as unknown as Location

describe('the Next internals the canvas relies on', () => {
  it('takes only the router’s request for this page’s server payload', () => {
    expect(isRouterRequest('http://localhost:4402/customers?page=2&_rsc=1x2y3', page)).toBe(true)
    expect(isRouterRequest('http://localhost:4402/customers?_rsc=1x2y3', page)).toBe(true)
    expect(isRouterRequest('http://localhost:4402/accounts?_rsc=1x2y3', page)).toBe(false) // a prefetch of another page
    expect(isRouterRequest('http://localhost:4402/customers?page=2', page)).toBe(false) // the document itself
    expect(isRouterRequest('http://localhost:5175/customers?_rsc=1x2y3', page)).toBe(false)
    expect(isRouterRequest('not a url', page)).toBe(false)
  })

  it('says why the router could not refresh, and refreshes it otherwise', () => {
    const calls: unknown[] = []
    const router = { refresh(this: unknown) { calls.push(this) } }
    expect(refreshRouter({ next: { router } } as unknown as Window)).toBeNull()
    expect(calls).toEqual([router])
    expect(refreshRouter({} as Window)).toBe('window.next.router.refresh is missing')
    expect(refreshRouter({ next: { router: { refresh: 1 } } } as unknown as Window)).toBe('window.next.router.refresh is missing')
    const broken = { next: { router: { refresh: () => { throw new Error('no app router') } } } } as unknown as Window
    expect(refreshRouter(broken)).toBe('window.next.router.refresh() threw: no app router')
  })

  it('waits for the route announcer, which Next adds after its root first committed', async () => {
    const doc = document.implementation.createHTMLDocument()
    Object.defineProperty(doc, 'defaultView', { value: window })
    let hydrated = 0
    whenHydrated(doc, () => hydrated++)
    doc.body.append(doc.createElement('div'))
    await Promise.resolve()
    expect(hydrated).toBe(0)
    doc.body.append(doc.createElement('next-route-announcer'))
    await Promise.resolve()
    expect(hydrated).toBe(1)
    expect(isHydrated(doc)).toBe(true)
    doc.body.append(doc.createElement('div')) // it stopped watching
    await Promise.resolve()
    expect(hydrated).toBe(1)

    whenHydrated(doc, () => hydrated++) // already hydrated: at once
    expect(hydrated).toBe(2)
  })
})
