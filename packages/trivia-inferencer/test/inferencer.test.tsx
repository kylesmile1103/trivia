// @vitest-environment jsdom
// The inferencer as a developer meets it: a banner over the live page, its code a click away,
// and Eject, with what the dev server says shown as it says it.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { Inferencer } from '../src/components/Inferencer'
import type { InferredPage } from '../src'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PAGE: InferredPage = {
  resource: 'Transaction',
  name: 'transactions',
  kind: 'show',
  component: 'TransactionShow',
  importPath: '@/pages/transactions/show',
  file: 'src/pages/transactions/show.tsx',
  exists: false,
  route: '/transactions/show/:id',
  module: '/@trivia/preview/abc.tsx',
  code: 'export function TransactionShow() {\n  return <p>Transaction</p>;\n}\n',
}

let host: HTMLElement | null = null
let unmount: (() => void) | null = null
afterEach(() => {
  act(() => unmount?.())
  host?.remove()
})

async function render(ui: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  unmount = () => root.unmount()
  await act(async () => root.render(ui))
  await settle()
  return host
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('nothing to click')
  await act(async () => (el as HTMLElement).click())
  await settle()
}
const button = (root: HTMLElement, name: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === name)

/** A dev server: preview answers PAGE; eject plans, and batch applies. */
function devServer(page: InferredPage = PAGE) {
  const calls: Array<{ url: string; body: any }> = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    calls.push({ url, body })
    const data = url.endsWith('/refine/preview') ? page : url.endsWith('/refine/eject') ? { ops: [{ op: 'createFile' }], label: `Eject ${page.component} to ${body.file ?? page.file}` } : { history: {} }
    return new Response(JSON.stringify({ ok: true, data }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetcher, calls }
}
const load = async () => ({ TransactionShow: () => <p>Live transaction</p> })

describe('the inferencer', () => {
  it('shows where the page comes from above the page itself, live', async () => {
    const { fetcher, calls } = devServer()
    const root = await render(<Inferencer kind="show" resource="transactions" fetcher={fetcher} load={load} />)
    expect(root.querySelector('section[aria-label="Trivia inferencer"]')?.textContent).toContain('Inferred from the OpenAPI contract: Transaction details page')
    expect(root.textContent).toContain('Live transaction')
    expect(calls).toEqual([{ url: '/@trivia/api/refine/preview', body: { resource: 'transactions', kind: 'show' } }])

    await click(button(root, 'View code'))
    const drawer = document.querySelector('aside[aria-label="Generated code for src/pages/transactions/show.tsx"]')
    expect(drawer?.textContent).toContain('export function TransactionShow()')
    await click(button(drawer as HTMLElement, 'Close'))
    expect(document.querySelector('aside')).toBeNull()
  })

  it('ejects to the file asked for, from where it stands', async () => {
    const { fetcher, calls } = devServer()
    const props = { kind: 'show' as const, resource: 'transactions', fetcher, load, 'data-ast-node': 'src/App.tsx#App#0.0.6' }
    const root = await render(<Inferencer {...props} />)
    await click(button(root, 'Eject to disk'))
    const input = root.querySelector<HTMLInputElement>('input[aria-label="File to write"]')!
    expect(input.value).toBe('src/pages/transactions/show.tsx')
    await click(button(root, 'Write the file'))
    expect(calls.slice(1).map((c) => [c.url, c.body])).toEqual([
      ['/@trivia/api/refine/eject', { resource: 'Transaction', kind: 'show', locator: 'src/App.tsx#App#0.0.6' }],
      ['/@trivia/api/batch', { ops: [{ op: 'createFile' }], label: 'Eject TransactionShow to src/pages/transactions/show.tsx' }],
    ])
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Wrote src/pages/transactions/show.tsx. The route now renders <TransactionShow />.')
  })

  it('won\'t overwrite a page that exists, and says what the dev server said when it fails', async () => {
    const root = await render(<Inferencer kind="show" resource="transactions" fetcher={devServer({ ...PAGE, exists: true }).fetcher} load={load} />)
    expect(button(root, 'Eject to disk')?.disabled).toBe(true)
    const failing = (async () => new Response(JSON.stringify({ ok: false, error: { code: 'node_not_found', message: 'the contract has no resource `cards`' } }), { status: 404 })) as typeof fetch
    const failed = await render(<Inferencer kind="list" resource="cards" fetcher={failing} load={load} />)
    expect(failed.querySelector('[role="alert"]')?.textContent).toBe('Trivia couldn\'t infer the cards list: the contract has no resource `cards`')
  })

  it('shows why the page could not render instead of blanking the route', async () => {
    const broken = async () => {
      throw new Error('Transform failed: unexpected token')
    }
    const root = await render(<Inferencer kind="show" resource="transactions" fetcher={devServer().fetcher} load={broken} />)
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('The inferred page failed to render: Transform failed: unexpected token')
  })
})
