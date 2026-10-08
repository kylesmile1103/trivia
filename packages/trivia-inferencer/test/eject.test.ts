// Eject's side of the contract with Trivia's dev server: the payload it sends, the two calls it
// makes (plan, then apply as one undo entry), and what it says when the dev server can't help.

import { describe, expect, it } from 'vitest'

import { TriviaApiError, ejectPayload, ejectToDisk, previewRequest, projectPath } from '../src'

type Call = { url: string; body: unknown }

/** A fetch that answers each call with the next reply, recording what it was asked. */
function fakeFetch(...replies: Array<{ status?: number; json?: unknown; text?: string } | Error>) {
  const calls: Call[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const reply = replies.shift()
    if (!reply) throw new Error('unexpected call')
    if (reply instanceof Error) throw reply
    const body = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? '')
    return new Response(body, { status: reply.status ?? 200, headers: { 'content-type': reply.json !== undefined ? 'application/json' : 'text/html' } })
  }) as typeof fetch
  return { fetcher, calls }
}

describe('the eject payload', () => {
  it('sends the target path relative to the project root, and only the options given', () => {
    expect(ejectPayload({ resource: 'customers', kind: 'list' })).toEqual({ resource: 'customers', kind: 'list' })
    expect(ejectPayload({ resource: 'customers', kind: 'show', file: './src/pages/c/show.tsx', hideFields: ['phone'], title: 'Client', locator: 'src/App.tsx#App#0.1' })).toEqual({
      resource: 'customers',
      kind: 'show',
      file: 'src/pages/c/show.tsx',
      hide: ['phone'],
      title: 'Client',
      locator: 'src/App.tsx#App#0.1',
    })
    expect(projectPath('/src/a.tsx')).toBe('src/a.tsx')
    expect(projectPath('src\\pages\\a.tsx')).toBe('src/pages/a.tsx')
    expect(ejectPayload({ resource: 'c', kind: 'edit', hideFields: [] })).toEqual({ resource: 'c', kind: 'edit' })
    expect(previewRequest('c', 'list', { ejectPath: './src/x.tsx', hideFields: ['a'] })).toEqual({ resource: 'c', kind: 'list', hide: ['a'], file: 'src/x.tsx' })
  })
})

describe('ejectToDisk', () => {
  it('plans, then applies the plan as one undo entry', async () => {
    const plan = { ops: [{ op: 'createFile', file: 'src/pages/customers/show.tsx', content: '…' }], label: 'Eject CustomerShow to src/pages/customers/show.tsx' }
    const { fetcher, calls } = fakeFetch({ json: { ok: true, data: plan } }, { json: { ok: true, data: { history: {} } } })
    const result = await ejectToDisk({ resource: 'customers', kind: 'show', locator: 'src/App.tsx#App#0.4' }, fetcher)
    expect(calls).toEqual([
      { url: '/@trivia/api/refine/eject', body: { resource: 'customers', kind: 'show', locator: 'src/App.tsx#App#0.4' } },
      { url: '/@trivia/api/batch', body: { ops: plan.ops, label: plan.label } },
    ])
    expect(result).toEqual({ label: plan.label, warnings: [] })
  })

  it('passes the dev server\'s refusal on, and applies nothing', async () => {
    const { fetcher, calls } = fakeFetch({ status: 409, json: { ok: false, error: { code: 'conflict', message: 'src/pages/customers/list.tsx already exists' } } })
    const error = await ejectToDisk({ resource: 'customers', kind: 'list' }, fetcher).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TriviaApiError)
    expect(error).toMatchObject({ code: 'conflict', message: 'src/pages/customers/list.tsx already exists' })
    expect(calls).toHaveLength(1)
  })

  it('says what to do when there is no dev server, or no Trivia plugin on it', async () => {
    const down = fakeFetch(new TypeError('Failed to fetch'))
    expect(await ejectToDisk({ resource: 'c', kind: 'list' }, down.fetcher).catch((e: unknown) => e)).toMatchObject({
      code: 'unreachable',
      message: expect.stringContaining('@trivia/vite-plugin-ast-locator'),
    })
    // A Vite server without the plugin answers with its HTML fallback, or a 404.
    const bare = fakeFetch({ status: 404, text: '<!doctype html>' })
    expect(await ejectToDisk({ resource: 'c', kind: 'list' }, bare.fetcher).catch((e: unknown) => e)).toMatchObject({
      code: 'no_plugin',
      message: expect.stringContaining('No Trivia API at /@trivia/api (HTTP 404)'),
    })
  })
})
