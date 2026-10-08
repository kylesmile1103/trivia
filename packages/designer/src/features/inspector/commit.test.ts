// An inspector edit committed as its element is left (./leave) goes through the action bus
// like any other edit, minus the bus's selection follow-up. Against a fetch stub whose apply
// answers when the test says so, as in shared/state/actions.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => [] as string[])
vi.mock('sonner', () => {
  const say = (kind: string) => (message: unknown) => {
    toasts.push(`${kind}: ${String(message)}`)
  }
  return { toast: Object.assign(say('message'), { error: say('error'), info: say('info'), success: say('success'), warning: say('warning') }) }
})

import type { ApplyResult, HistoryState, NodeDetails, Op } from '@/shared/engine/types'
import { isApplying } from '@/shared/state/actions'
import { designer } from '@/shared/state/store'

import { commitProp } from './commit'

const FILE = 'src/pages/Dashboard.tsx'
const at = (path: string) => `${FILE}#Dashboard#${path}`
const HISTORY: HistoryState = { canUndo: true, canRedo: false, undoLabel: 'Edit', redoLabel: null }

interface Pending {
  op: Op
  answer(result: Partial<ApplyResult>): void
  refuse(): void
}

let pending: Pending[] = []

beforeEach(() => {
  pending = []
  toasts.length = 0
  vi.stubGlobal('fetch', (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { op } = JSON.parse(String(init?.body)) as { op: Op }
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    return new Promise<Response>((resolve) => {
      pending.push({
        op,
        answer: (result) => resolve(reply({ ok: true, data: { file: FILE, changed: true, locator: null, history: HISTORY, ...result } })),
        refuse: () => resolve(reply({ ok: false, error: { code: 'stale_locator', message: 'expected <Button>' } }, 409)),
      })
    })
  }) as typeof fetch)
  designer.setState({ selected: null, details: null, pressPending: false, lastEdit: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('an inspector edit committed after the user selected something else', () => {
  const details = { locator: at('0.0.1'), name: 'Button' } as NodeDetails

  it('is an edit in flight like any other, and tells the canvas which file it wrote', async () => {
    designer.getState().select(at('0.2'))
    const done = commitProp(details, 'variant', 'outline')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0]!.op).toMatchObject({ op: 'updateProp', target: at('0.0.1'), expectedName: 'Button' })
    expect(isApplying()).toBe(true)
    pending[0]!.answer({ locator: at('0.0.1') })
    expect(await done).toBe(true)
    expect(isApplying()).toBe(false)
    expect(designer.getState().lastEdit?.files).toEqual([FILE])
  })

  it('leaves the selection where the user put it', async () => {
    designer.getState().select(at('0.2'))
    const done = commitProp(details, 'variant', 'outline')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!.answer({ locator: at('0.0.1') })
    await done
    expect(designer.getState().selected).toBe(at('0.2'))
  })

  it('names the edit when it is refused, since the user is looking elsewhere', async () => {
    designer.getState().select(at('0.2'))
    const done = commitProp(details, 'variant', 'outline', 'Set Button.variant')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!.refuse()
    expect(await done).toBe(false)
    expect(isApplying()).toBe(false)
    expect(toasts).toEqual(['error: Couldn’t apply “Set Button.variant”: expected <Button>'])
  })
})
