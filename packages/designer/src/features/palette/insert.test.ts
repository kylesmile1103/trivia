import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NodeDetails, Op } from '@/shared/engine/types'
import { designer } from '@/shared/state/store'

import { insertIntoSelection, placementFor } from './insert'

vi.mock('sonner', () => ({ toast: Object.assign(() => {}, { error: () => {}, info: () => {} }) }))

const CONTENT = 'src/pages/Dashboard.tsx#Dashboard#0.0.1'

function details(name: string): NodeDetails {
  return {
    locator: CONTENT,
    file: 'src/pages/Dashboard.tsx',
    name,
    isFragment: false,
    line: 26,
    column: 9,
    isRoot: false,
    isDirect: true,
    parent: null,
    children: [],
    attributes: [],
    text: null,
  }
}

describe('insertIntoSelection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    designer.getState().select(null)
  })

  it('names the selected node, so a selection that now points elsewhere is refused (409), not inserted into', async () => {
    const sent: Op[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      sent.push((JSON.parse(String(init?.body)) as { op: Op }).op)
      const data = { file: 'src/pages/Dashboard.tsx', changed: false, locator: null, history: designer.getState().history }
      return new Response(JSON.stringify({ ok: true, data }), { headers: { 'content-type': 'application/json' } })
    })
    const s = designer.getState()
    s.select(CONTENT)
    s.setDetails(details('CardContent'))
    const imports = [{ name: 'Badge', source: '@/components/ui/badge' }]
    await insertIntoSelection({ component: 'Badge', label: 'Badge', snippet: '<Badge>Badge</Badge>', imports })
    expect(sent).toEqual([
      { op: 'insert', target: CONTENT, expectedName: 'CardContent', placement: 'lastChild', snippet: '<Badge>Badge</Badge>', imports },
    ])
  })
})

describe('placementFor', () => {
  it('inserts into containers as the last child', () => {
    expect(placementFor({ name: 'CardContent' }, true)).toBe('lastChild')
    expect(placementFor({ name: 'div' }, undefined)).toBe('lastChild')
  })

  it('inserts after components and elements that take no children', () => {
    expect(placementFor({ name: 'Input' }, false)).toBe('after')
    expect(placementFor({ name: 'input' }, undefined)).toBe('after')
    expect(placementFor({ name: 'img' }, undefined)).toBe('after')
  })
})
