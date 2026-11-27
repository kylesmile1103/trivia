// The action bus's selection follow-up and its bookkeeping for the canvas, against a fetch stub
// whose apply answers when the test says so: the window between sending an edit and hearing
// back is where the user keeps working.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => [] as string[])
vi.mock('sonner', () => {
  const say = (kind: string) => (message: unknown) => {
    toasts.push(`${kind}: ${String(message)}`)
  }
  return { toast: Object.assign(say('message'), { error: say('error'), info: say('info'), success: say('success'), warning: say('warning') }) }
})

import type { ApplyResult, HistoryState, Op } from '@/shared/engine/types'

import { dispatch, isApplying, onIdle } from './actions'
import { designer } from './store'

const FILE = 'src/pages/Dashboard.tsx'
const at = (path: string) => `${FILE}#Dashboard#${path}`
const HISTORY: HistoryState = { canUndo: true, canRedo: false, undoLabel: 'Edit', redoLabel: null }

interface Pending {
  op: Op
  /** What was sent besides the op (`label`, `follow`). */
  body: Record<string, unknown>
  answer(result: Partial<ApplyResult>): void
  refuse(): void
}

/** Every apply the bus sends waits here until the test answers it. */
let pending: Pending[] = []

beforeEach(() => {
  pending = []
  toasts.length = 0
  vi.stubGlobal('fetch', (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { op: Op } & Record<string, unknown>
    const { op } = body
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    return new Promise<Response>((resolve) => {
      pending.push({
        op,
        body,
        answer: (result) => resolve(reply({ ok: true, data: { file: FILE, changed: true, locator: null, history: HISTORY, ...result } })),
        refuse: () => resolve(reply({ ok: false, error: { code: 'stale_locator', message: 'expected <Button>' } }, 409)),
      })
    })
  }) as typeof fetch)
  designer.setState({ selected: null, details: null, pressPending: false, lastEdit: null, expectedSelectedName: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Send `op`, run `meanwhile` while it is on its way, then answer it with `result`. */
async function edit(op: Op, result: Partial<ApplyResult>, meanwhile: () => void = () => {}) {
  const done = dispatch(op, 'Edit')
  await vi.waitFor(() => expect(pending).toHaveLength(1))
  meanwhile()
  pending[0]!.answer(result)
  return done
}

const move: Op = { op: 'move', source: at('0.0.1'), expectedName: 'Button', target: at('0.0.0'), expectedTargetName: 'div', placement: 'before' }

describe('the selection follow-up', () => {
  it('follows the edit’s result when the selection is unchanged since it was sent', async () => {
    designer.getState().select(at('0.0.1'))
    await edit(move, { locator: at('0.0.0') })
    expect(designer.getState().selected).toBe(at('0.0.0'))
  })

  it('keeps a selection the user made while the edit was on its way', async () => {
    designer.getState().select(at('0.0.1'))
    await edit(move, { locator: at('0.0.0') }, () => designer.getState().select(at('0.2')))
    expect(designer.getState().selected).toBe(at('0.2'))
  })

  it('keeps it after a removal too, instead of clearing it', async () => {
    designer.getState().select(at('0.0.1'))
    await edit({ op: 'remove', target: at('0.0.1'), expectedName: 'Button' }, { locator: null }, () => designer.getState().select(at('0.2')))
    expect(designer.getState().selected).toBe(at('0.2'))
  })

  it('clears it after a removal of the selected node, as before', async () => {
    designer.getState().select(at('0.0.1'))
    await edit({ op: 'remove', target: at('0.0.1'), expectedName: 'Button' }, { locator: null })
    expect(designer.getState().selected).toBeNull()
  })

  it('follows when the selection moved to the node the edit is about (its own edit)', async () => {
    designer.getState().select(at('0.2'))
    await edit(move, { locator: at('0.0.0') }, () => designer.getState().select(at('0.0.1')))
    expect(designer.getState().selected).toBe(at('0.0.0'))
  })

  it('leaves the selection to a canvas press that is waiting to select', async () => {
    designer.getState().select(at('0.0.1'))
    await edit(move, { locator: at('0.0.0') }, () => designer.getState().setPressPending(true))
    expect(designer.getState().selected).toBe(at('0.0.1'))
    expect(designer.getState().pressPending).toBe(true)
  })

  it('still drops a removed node while a canvas press waits, and keeps the press', async () => {
    designer.getState().select(at('0.0.1'))
    await edit({ op: 'remove', target: at('0.0.1'), expectedName: 'Button' }, { locator: null }, () =>
      designer.getState().setPressPending(true),
    )
    expect(designer.getState()).toMatchObject({ selected: null, pressPending: true })
  })
})

describe('the selection after a value op in its file, which renumbers the JSX after the literal', () => {
  // A column added before the page tree: every locator of the tree moves one root on.
  const column: Op = { op: 'insertElement', path: `${FILE}#Dashboard#columns`, index: 0, value: '{ id: "since", header: () => <span>Since</span> }' }

  it('is sent to be followed, and goes where the engine followed it', async () => {
    designer.getState().select(at('0.0.1'))
    await edit(column, { followed: [`${FILE}#Dashboard#1.0.1`] })
    expect(pending[0]!.body['follow']).toEqual([at('0.0.1')])
    expect(designer.getState().selected).toBe(`${FILE}#Dashboard#1.0.1`)
  })

  it('lets go when the engine says the node is gone or its place is unknown', async () => {
    designer.getState().select(at('0.0.1'))
    await edit(column, { followed: [null] })
    expect(designer.getState().selected).toBeNull()
    designer.getState().select(at('0.0.1'))
    pending = []
    await edit(column, {}) // an engine too old to follow
    expect(designer.getState().selected).toBeNull()
  })

  it('lets go of a selection made in that file while the edit was on its way: it was read from the old file', async () => {
    designer.getState().select(at('0.0.1'))
    await edit(column, { followed: [`${FILE}#Dashboard#1.0.1`] }, () => designer.getState().select(at('0.0.2')))
    expect(designer.getState().selected).toBeNull()
  })

  it('keeps a waiting canvas press waiting while it re-addresses the node', async () => {
    designer.getState().select(at('0.0.1'))
    await edit(column, { followed: [`${FILE}#Dashboard#1.0.1`] }, () => designer.getState().setPressPending(true))
    expect(designer.getState()).toMatchObject({ selected: `${FILE}#Dashboard#1.0.1`, pressPending: true })
  })

  it('expects the tag it had, so details naming another element let it go', async () => {
    designer.getState().select(at('0.0.1'))
    designer.getState().setDetails({ locator: at('0.0.1'), name: 'Button' } as never)
    await edit(column, { followed: [`${FILE}#Dashboard#1.0.1`] })
    expect(designer.getState()).toMatchObject({ selected: `${FILE}#Dashboard#1.0.1`, expectedSelectedName: 'Button' })
    designer.getState().setDetails({ locator: `${FILE}#Dashboard#1.0.1`, name: 'Badge' } as never)
    expect(designer.getState().selected).toBeNull()
  })

  it('sends nothing to follow when nothing is selected', async () => {
    await edit(column, {})
    expect(pending[0]!.body).not.toHaveProperty('follow')
  })
})

describe('a waiting canvas press in the store', () => {
  it('is superseded by any selection, even of the node already selected', () => {
    const s = designer.getState()
    s.select(at('0.1'))
    s.setPressPending(true)
    s.select(at('0.1'))
    expect(designer.getState().pressPending).toBe(false)
    s.setPressPending(true)
    s.select(null)
    expect(designer.getState()).toMatchObject({ pressPending: false, selected: null })
  })
})

describe('what the canvas learns about an edit', () => {
  it('records the files an edit changed and when it was sent, with its history', async () => {
    const before = performance.now()
    await edit(move, { locator: at('0.0.0') })
    const { lastEdit, history } = designer.getState()
    expect(history).toEqual(HISTORY)
    expect(lastEdit?.files).toEqual([FILE])
    expect(lastEdit?.sentAt).toBeGreaterThanOrEqual(before)
    expect(lastEdit?.sentAt).toBeLessThanOrEqual(performance.now())
  })

  it('forgets it when the history comes from anywhere else', async () => {
    await edit(move, { locator: at('0.0.0') })
    designer.getState().setHistory({ ...HISTORY, undoLabel: 'Written elsewhere' })
    expect(designer.getState().lastEdit).toBeNull()
  })

  it('says when the last edit in flight has answered, whether it was applied or refused', async () => {
    const idle = vi.fn()
    const stop = onIdle(idle)
    try {
      const first = dispatch(move, 'First')
      const second = dispatch(move, 'Second')
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      pending[0]!.answer({ locator: at('0.0.0') })
      await first
      expect(isApplying()).toBe(true)
      expect(idle).not.toHaveBeenCalled()
      pending[1]!.refuse()
      await second
      expect(isApplying()).toBe(false)
      expect(idle).toHaveBeenCalledTimes(1)
      expect(toasts).toEqual(['error: expected <Button>'])
    } finally {
      stop()
    }
  })
})
