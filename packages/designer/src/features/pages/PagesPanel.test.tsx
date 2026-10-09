// @vitest-environment jsdom
//
// The Pages tab over a stub engine and canvas: it lists the app's routes, marks the one the canvas
// is on, loads a route in the canvas (asking for its params first), and loads any typed path.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type CanvasApi, setCanvasApi } from '@/shared/canvas'
import { engine } from '@/shared/engine/client'
import type { AppRoute } from '@/shared/engine/types'
import { find, type Mounted, mount, settle, typeInto } from '@/shared/lib/test-utils'
import { designer } from '@/shared/state/store'

import { PagesPanel } from './PagesPanel'

const route = (path: string, extra: Partial<AppRoute> = {}): AppRoute => ({
  path,
  params: [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!).concat(path.endsWith('*') ? ['*'] : []),
  index: false,
  catchAll: path.endsWith('*'),
  router: 'react-router',
  component: null,
  file: null,
  declared: { file: 'src/App.tsx', line: 1 },
  locator: null,
  resource: null,
  ...extra,
})

const ROUTES: AppRoute[] = [
  route('/', { index: true, component: 'NavigateToResource' }),
  route('/customers', { component: 'CustomerList', file: 'src/pages/customers/list.tsx', resource: { name: 'customers', action: 'list' } }),
  route('/customers/edit/:id', { component: 'CustomerEdit', file: 'src/pages/customers/edit.tsx', resource: { name: 'customers', action: 'edit' } }),
  route('/accounts', { component: 'AccountList', file: 'src/pages/accounts/list.tsx' }),
  route('/*', { component: 'ErrorComponent', file: 'src/components/error.tsx' }),
]

let ui: Mounted | null = null
let navigate: ReturnType<typeof vi.fn>

beforeEach(() => {
  navigate = vi.fn()
  setCanvasApi({ navigate } as unknown as CanvasApi)
  vi.spyOn(engine, 'routes').mockResolvedValue(ROUTES)
  designer.setState({ canvasPath: '/customers?page=2', revision: 0 })
})

afterEach(async () => {
  await ui?.unmount()
  ui = null
  setCanvasApi(null)
  vi.restoreAllMocks()
})

const rows = () => [...document.querySelectorAll('[data-route]')] as HTMLElement[]
const row = (path: string) => find(document, `[data-route="${path}"]`)
const press = async (el: Element) => act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const enter = async (el: Element) =>
  act(async () => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))

async function open(): Promise<void> {
  ui = await mount(<PagesPanel />)
  await settle()
}

describe('the Pages tab', () => {
  it('lists each route with its label, URL and page file, and marks where the canvas is', async () => {
    await open()
    expect(rows().map((r) => r.querySelector('[data-label]')!.textContent)).toEqual([
      'NavigateToResource',
      'Customers · List',
      'Customers · Edit',
      'AccountList',
      'ErrorComponent',
    ])
    expect(row('/customers/edit/:id').textContent).toContain('/customers/edit/:id')
    expect(row('/customers/edit/:id').textContent).toContain('pages/customers/edit.tsx')
    // The query string doesn't change which route the canvas is on; the catch-all only counts
    // when nothing else matches.
    expect(rows().filter((r) => r.getAttribute('aria-current') === 'page').map((r) => r.dataset.route)).toEqual(['/customers'])
  })

  it('loads a route without params in the canvas on click', async () => {
    await open()
    await press(row('/accounts'))
    expect(navigate).toHaveBeenCalledWith('/accounts')
  })

  it("asks for a route's params, prefilled from the canvas URL when it is on that route", async () => {
    designer.setState({ canvasPath: '/customers/edit/7' })
    await open()
    await press(row('/customers/edit/:id'))
    expect(navigate).not.toHaveBeenCalled()
    const id = find<HTMLInputElement>(document, 'input[aria-label="id"]')
    expect(id.value).toBe('7')
    await typeInto(id, '42')
    await enter(id)
    expect(navigate).toHaveBeenCalledWith('/customers/edit/42')

    // Empty, it has no URL to go to.
    await typeInto(id, '')
    expect(find<HTMLButtonElement>(document, 'button[aria-label="Open /customers/edit/:id"]').disabled).toBe(true)
  })

  it('remembers a param it was given, for the next route that needs it', async () => {
    await open()
    await press(row('/customers/edit/:id'))
    await typeInto(find<HTMLInputElement>(document, 'input[aria-label="id"]'), '9')
    await press(find(document, 'button[aria-label="Open /customers/edit/:id"]'))
    expect(navigate).toHaveBeenCalledWith('/customers/edit/9')
    await ui!.unmount()
    await open()
    await press(row('/customers/edit/:id'))
    expect(find<HTMLInputElement>(document, 'input[aria-label="id"]').value).toBe('9')
  })

  it('loads any path typed in the path field', async () => {
    await open()
    const field = find<HTMLInputElement>(document, 'input[aria-label="Path"]')
    expect(field.value).toBe('/customers?page=2')
    await typeInto(field, 'accounts?tab=all')
    await enter(field)
    expect(navigate).toHaveBeenCalledWith('/accounts?tab=all')
  })

  it('says so when the app has no routes, and when they could not be read', async () => {
    vi.mocked(engine.routes).mockResolvedValue([])
    await open()
    expect(document.body.textContent).toContain('No routes found')
    await ui!.unmount()

    vi.mocked(engine.routes).mockRejectedValue(new Error('engine is down'))
    await open()
    expect(document.body.textContent).toContain('engine is down')
  })

  it('reads the routes again after a re-render', async () => {
    await open()
    vi.mocked(engine.routes).mockResolvedValue([...ROUTES, route('/reports', { component: 'Reports' })])
    await act(async () => designer.getState().bumpRevision())
    await settle()
    expect(rows().map((r) => r.dataset.route)).toContain('/reports')
  })
})
