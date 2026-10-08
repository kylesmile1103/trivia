// The designer's half of point-and-ask (docs/mcp.md), against a fetch stub that plays the
// plugin's /selection endpoint.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NodeDetails, SelectionState } from '@/shared/engine/types'
import { designer } from '@/shared/state/store'

import { resetSelectionSync, startSelectionSync, syncSelection } from './selection-sync'

const FILE = 'src/pages/Dashboard.tsx'
const at = (path: string) => `${FILE}#Dashboard#${path}`

function details(locator: string, name: string): NodeDetails {
  return { locator, file: FILE, name, isFragment: false, line: 1, column: 1, isRoot: false, isDirect: true, parent: null, children: [], attributes: [], text: null }
}

/** The plugin's selection store, reduced. */
let plugin: SelectionState
const posts: unknown[] = []

beforeEach(() => {
  plugin = { selection: null, version: 0, by: null }
  posts.length = 0
  resetSelectionSync()
  designer.setState({ selected: null, details: null, expectedSelectedName: null, pressPending: false })
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { locator: string | null; name?: string }
      posts.push(body)
      const selection = body.locator === null ? null : { locator: body.locator, name: body.name ?? '' }
      if (JSON.stringify(selection) !== JSON.stringify(plugin.selection)) plugin = { selection, version: plugin.version + 1, by: 'designer' }
    }
    expect(String(input)).toBe('/@trivia/api/selection')
    return new Response(JSON.stringify({ ok: true, data: plugin }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Start publishing; the startup post (a fresh designer has nothing selected) is checked, then forgotten. */
async function start(): Promise<() => void> {
  const stop = startSelectionSync()
  await flush()
  expect(posts).toEqual([{ locator: null }])
  posts.length = 0
  return stop
}

/** The user clicks `locator`, and the inspector's details for it arrive. */
async function userSelects(locator: string, name: string) {
  designer.getState().select(locator)
  designer.getState().setDetails(details(locator, name))
  await flush()
}

describe('publishing the selection', () => {
  it('posts each selection once its tag name is known, and a deselection', async () => {
    const stop = await start()
    try {
      designer.getState().select(at('0.1'))
      await flush()
      expect(posts).toEqual([]) // no name yet
      designer.getState().setDetails(details(at('0.1'), 'Button'))
      await flush()
      expect(posts).toEqual([{ locator: at('0.1'), name: 'Button' }])
      designer.getState().setDetails(details(at('0.1'), 'Button')) // a refetch after HMR
      await flush()
      expect(posts).toHaveLength(1)
      designer.getState().select(null)
      await flush()
      expect(posts).toEqual([{ locator: at('0.1'), name: 'Button' }, { locator: null }])
    } finally {
      stop()
    }
  })

  it('does not post a selection the safety check dropped: the plugin may know better', async () => {
    const stop = await start()
    try {
      await userSelects(at('0.1'), 'Button')
      designer.getState().bumpRevision()
      designer.getState().setDetails(details(at('0.1'), 'Badge')) // another element there now
      await flush()
      expect(designer.getState().selected).toBeNull()
      expect(posts).toHaveLength(1)
    } finally {
      stop()
    }
  })
})

describe('adopting an agent’s selection', () => {
  it('selects where an agent’s edit moved the selection', async () => {
    const stop = await start()
    try {
      await userSelects(at('0.1'), 'Button')
      plugin = { selection: { locator: at('0.2'), name: 'Button' }, version: plugin.version + 1, by: 'agent' }
      await syncSelection()
      expect(designer.getState().selected).toBe(at('0.2'))
      designer.getState().setDetails(details(at('0.2'), 'Button'))
      await flush()
      expect(posts).toHaveLength(1) // what the plugin already holds is not posted back
    } finally {
      stop()
    }
  })

  it('takes an agent’s deselection too, once', async () => {
    await userSelects(at('0.1'), 'Button')
    plugin = { selection: null, version: plugin.version + 1, by: 'agent' }
    await syncSelection()
    expect(designer.getState().selected).toBeNull()
    designer.getState().select(at('0.3')) // the user picks something else afterwards
    await syncSelection()
    expect(designer.getState().selected).toBe(at('0.3'))
  })

  it('ignores what the designer itself posted', async () => {
    plugin = { selection: { locator: at('0.4'), name: 'Card' }, version: 3, by: 'designer' }
    await syncSelection()
    expect(designer.getState().selected).toBeNull()
  })

  it('posts its selection again when the plugin restarted (its version went back)', async () => {
    const stop = await start()
    try {
      await userSelects(at('0.1'), 'Button')
      plugin = { selection: null, version: 0, by: null } // a new dev server
      await syncSelection()
      await flush()
      expect(posts.at(-1)).toEqual({ locator: at('0.1'), name: 'Button' })
      expect(plugin.selection).toEqual({ locator: at('0.1'), name: 'Button' })
    } finally {
      stop()
    }
  })
})
