// @vitest-environment jsdom
//
// The style panel's numeric controls in a real React tree (jsdom, the real Radix Slider and the
// real global shortcuts): what a deferred or interrupted gesture ends up writing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useGlobalShortcuts } from '@/shared/commands/shortcuts'
import { isMac } from '@/shared/lib/env'
import { designer } from '@/shared/state/store'

import { find, type Mounted, mount, press, settle, typeInto } from '@/shared/lib/test-utils'
import { StylePanel } from './StylePanel'

const engine = vi.hoisted(() => ({ undo: vi.fn(), redo: vi.fn() }))
const toasts = vi.hoisted(() => [] as unknown[])
vi.mock('sonner', async (importOriginal) => {
  const real = await importOriginal<typeof import('sonner')>()
  const record = (message: unknown) => toasts.push(message)
  return { ...real, toast: Object.assign(record, { error: record, warning: record, info: record, success: record }) }
})
vi.mock('@/shared/engine/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/shared/engine/client')>()
  const history = { canUndo: true, canRedo: true, undoLabel: null, redoLabel: null }
  engine.undo.mockImplementation(async () => ({ history }))
  engine.redo.mockImplementation(async () => ({ history }))
  return { ...real, engine: { ...real.engine, undo: engine.undo, redo: engine.redo } }
})

/** The settle window of keyboard changes on the slider (fields.tsx), plus slack. */
const AFTER_SETTLE_MS = 600
const LOCATOR = 'src/App.tsx#App#0'
const MOD = isMac ? { metaKey: true } : { ctrlKey: true }

function Shortcuts() {
  useGlobalShortcuts()
  return null
}

let commits: Array<{ className: string; label: string | undefined }>
let view: Mounted | null

function panel(className: string) {
  return (
    <>
      <Shortcuts />
      <StylePanel
        locator={LOCATOR}
        className={className}
        onPreview={() => {}}
        onCommit={(next, label) => void commits.push({ className: next, label })}
      />
    </>
  )
}

async function open(className: string) {
  view = await mount(panel(className))
  const thumb = find(view.host, '[role="slider"][aria-label="Padding"]')
  const field = find<HTMLInputElement>(view.host, 'input[aria-label="Padding"]')
  return { view, thumb, field }
}

const written = () => commits.map((c) => c.className)

beforeEach(() => {
  commits = []
  view = null
  toasts.length = 0
  // The canvas moved on: an unmounting panel is being left (see inspector/leave.ts).
  designer.getState().select(null)
  engine.undo.mockClear()
  engine.redo.mockClear()
})

afterEach(async () => {
  await view?.unmount()
})

describe('ScrubSlider keyboard changes', () => {
  it('write once the burst settles', async () => {
    const { thumb } = await open('p-4 flex')
    thumb.focus()
    await press(thumb, { key: 'ArrowRight' })
    expect(thumb.getAttribute('aria-valuenow')).toBe('20')
    expect(written()).toEqual([])
    await settle(AFTER_SETTLE_MS)
    expect(written()).toEqual(['p-5 flex'])
  })

  it('compute the deferred write from the className at fire time, not from the render that armed it', async () => {
    const { view, thumb } = await open('p-4 flex')
    thumb.focus()
    await press(thumb, { key: 'ArrowRight' })
    // The source changes while the write waits (an undo, an edit in the IDE, another client).
    await view.render(panel('p-4'))
    await settle(AFTER_SETTLE_MS)
    expect(written()).toEqual(['p-5'])
  })

  it('take back an unwritten change on undo instead of undoing the previous edit', async () => {
    const { thumb } = await open('p-4 flex')
    thumb.focus()
    await press(thumb, { key: 'ArrowRight' })
    const undo = await press(thumb, { key: 'z', ...MOD })
    expect(undo.defaultPrevented).toBe(true)
    expect(engine.undo).not.toHaveBeenCalled()
    expect(thumb.getAttribute('aria-valuenow')).toBe('16')
    await settle(AFTER_SETTLE_MS)
    expect(written()).toEqual([])

    // Nothing pending any more: the next undo is the engine's.
    await press(thumb, { key: 'z', ...MOD })
    expect(engine.undo).toHaveBeenCalledTimes(1)
  })

  it('write an unwritten change at once on redo (a new edit leaves nothing to redo)', async () => {
    const { thumb } = await open('p-4 flex')
    thumb.focus()
    await press(thumb, { key: 'ArrowRight' })
    const redo = await press(thumb, { key: 'z', shiftKey: true, ...MOD })
    expect(redo.defaultPrevented).toBe(true)
    expect(engine.redo).not.toHaveBeenCalled()
    expect(written()).toEqual(['p-5 flex'])
    await settle(AFTER_SETTLE_MS)
    expect(written()).toEqual(['p-5 flex'])
  })

  it('write an unwritten change when the panel unmounts (selection moved on)', async () => {
    const { view, thumb } = await open('p-4 flex')
    thumb.focus()
    await press(thumb, { key: 'ArrowRight' })
    await view.unmount()
    expect(written()).toEqual(['p-5 flex'])
    await settle(AFTER_SETTLE_MS)
    expect(written()).toEqual(['p-5 flex'])
  })

  it('write nothing on unmount while the element is still selected (the source changed under it), and say so', async () => {
    designer.getState().select(LOCATOR)
    const { view, thumb } = await open('p-4 flex')
    thumb.focus()
    await press(thumb, { key: 'ArrowRight' })
    await view.unmount()
    await settle(AFTER_SETTLE_MS)
    expect(written()).toEqual([])
    expect(toasts).toEqual(['Padding not applied'])
  })

  it('write nothing more on unmount once the change is written', async () => {
    const { view, thumb } = await open('p-4 flex')
    thumb.focus()
    await press(thumb, { key: 'ArrowRight' })
    await settle(AFTER_SETTLE_MS)
    await view.unmount()
    expect(written()).toEqual(['p-5 flex'])
  })
})

describe('ScrubField typed values', () => {
  it('commit when the panel unmounts before the field blurs (canvas click)', async () => {
    const { view, field } = await open('p-4 flex')
    await typeInto(field, '24')
    expect(written()).toEqual([])
    await view.unmount()
    expect(commits).toEqual([{ className: 'p-6 flex', label: 'Padding p-6' }])
  })

  it('commit once: Enter, then unmount', async () => {
    const { view, field } = await open('p-4 flex')
    await typeInto(field, '24')
    await press(field, { key: 'Enter' })
    await view.unmount()
    expect(written()).toEqual(['p-6 flex'])
  })

  it('write nothing on unmount while the element is still selected, and say so', async () => {
    designer.getState().select(LOCATOR)
    const { view, field } = await open('p-4 flex')
    await typeInto(field, '24')
    await view.unmount()
    expect(written()).toEqual([])
    expect(toasts).toEqual(['Padding “24” not applied'])
  })

  it('commit nothing after Escape', async () => {
    const { view, field } = await open('p-4 flex')
    await typeInto(field, '24')
    await press(field, { key: 'Escape' })
    await view.unmount()
    expect(written()).toEqual([])
  })
})
