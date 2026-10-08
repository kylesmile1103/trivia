// The action bus: every change to user code goes through `dispatch`, so history, selection
// follow-up and error reporting behave the same for clicks, drags, setters and (later) agents.

import { toast } from 'sonner'

import { ApiError, engine } from '@/shared/engine/client'
import type { ApplyResult, HistoryResult, Op } from '@/shared/engine/types'

import { designer } from './store'

/** Edits sent to the engine (apply, batch, undo, redo) that haven't answered yet. */
let inFlight = 0
const idleListeners = new Set<() => void>()

/**
 * True while an edit is on its way to disk. Its file may already be written, so a locator read
 * from the canvas, and any engine lookup for it, can disagree from that moment until HMR has
 * re-rendered the app. The store's `history` changes when the edit lands, before this clears.
 */
export function isApplying(): boolean {
  return inFlight > 0
}

/**
 * Call `listener` whenever the last edit in flight has answered (applied, unchanged, refused or
 * failed), after the store has taken its result. Returns the unsubscribe function.
 */
export function onIdle(listener: () => void): () => void {
  idleListeners.add(listener)
  return () => idleListeners.delete(listener)
}

function answered(): void {
  inFlight--
  if (inFlight === 0) for (const listener of [...idleListeners]) listener()
}

/** Toast `error`; `edit` names the edit when the user is no longer looking at it. */
function report(error: unknown, edit?: string): void {
  const message = error instanceof ApiError ? error.message : String(error)
  toast.error(edit === undefined ? message : `Couldn’t apply “${edit}”: ${message}`)
}

export interface DispatchOptions {
  /**
   * Select what the edit produced (`followSelection`; the default). False for an edit committed
   * after the user selected something else (the inspector's leave-commit, features/inspector/leave.ts):
   * following it would pull the selection back from where they just put it. Its error toast
   * then names the edit.
   */
  follow?: boolean
}

/** Apply one op (one undo entry). Selects the affected node afterwards, unless the user moved on (`followSelection`). */
export async function dispatch(op: Op, label: string, { follow = true }: DispatchOptions = {}): Promise<ApplyResult | null> {
  return run(() => engine.apply(op, label), [op], follow ? null : label)
}

/** Apply several ops as one transaction (one undo entry), e.g. a gesture. */
export async function dispatchBatch(ops: Op[], label: string): Promise<ApplyResult | null> {
  return run(() => engine.batch(ops, label), ops, null)
}

/** `left`: the label of an edit the user has left behind (`follow: false`), else null. */
async function run(call: () => Promise<ApplyResult>, ops: readonly Op[], left: string | null): Promise<ApplyResult | null> {
  const sentAt = performance.now()
  const selectedBefore = designer.getState().selected
  inFlight++
  try {
    const result = await call()
    // A new `history` tells the canvas an HMR is on its way; an unchanged result writes
    // nothing and adds no entry (docs/api.md), so there is nothing to wait for.
    if (result.changed) designer.getState().setHistory(result.history, { files: filesOf(result.file, ops), sentAt })
    if (left === null) followSelection(result, ops.at(-1), selectedBefore)
    return result
  } catch (error) {
    report(error, left ?? undefined)
    return null
  } finally {
    answered()
  }
}

/**
 * Select what the edit produced, unless the user has moved on while it was on its way: an
 * answer that pulled the selection back would undo their click. So the result is followed only
 * when the selection is unchanged since the edit was sent, or is the node the edit was about
 * (re-selected meanwhile), and no canvas press is waiting to select. A removal still lets go of
 * its node when that is what is selected; a waiting press keeps waiting.
 */
function followSelection(result: ApplyResult, last: Op | undefined, selectedBefore: string | null): void {
  const s = designer.getState()
  const subject = last ? subjectOf(last) : null
  if (s.selected !== selectedBefore && (subject === null || s.selected !== subject)) return
  if (result.locator) {
    if (!s.pressPending) s.select(result.locator)
  } else if (last?.op === 'remove') {
    const waiting = s.pressPending
    s.select(null)
    if (waiting) s.setPressPending(true)
  }
}

/** The node an op edits in place or moves (its result locator is that node's new one). */
function subjectOf(op: Op): string | null {
  switch (op.op) {
    case 'updateProp':
    case 'setText':
    case 'remove':
    case 'bindQuery':
      return op.target
    case 'move':
    case 'moveNode':
      return op.source
    default:
      return null
  }
}

/** Every file the ops write: each op's own file, and a move's destination file (it may be another). */
function filesOf(resultFile: string, ops: readonly Op[]): string[] {
  const files = new Set([resultFile])
  for (const op of ops) {
    if (op.op === 'createFile') {
      files.add(op.file)
      continue
    }
    const locators =
      op.op === 'insertChild' ? [op.parent] : op.op === 'move' ? [op.source, op.target] : op.op === 'moveNode' ? [op.source, op.parent] : [op.target]
    for (const locator of locators) {
      const file = locatorFile(locator)
      if (file) files.add(file)
    }
  }
  return [...files]
}

/** `<file>#<component>#<path>`: the file part, split from the right (file paths may contain `#`). */
function locatorFile(locator: string): string {
  const last = locator.lastIndexOf('#')
  const mid = last > 0 ? locator.lastIndexOf('#', last - 1) : -1
  return mid > 0 ? locator.slice(0, mid) : ''
}

/** Remember what is selected so a history jump can't silently retarget the selection. */
function guardSelection(): void {
  const s = designer.getState()
  const name = s.details && s.details.locator === s.selected ? s.details.name : null
  if (name !== null) s.expectSelectedName(name)
}

async function jump(call: () => Promise<HistoryResult>): Promise<void> {
  guardSelection()
  const sentAt = performance.now()
  inFlight++
  try {
    const r = await call()
    designer.getState().setHistory(r.history, { files: r.files, sentAt })
  } catch (error) {
    report(error)
  } finally {
    answered()
  }
}

export async function undo(): Promise<void> {
  return jump(() => engine.undo())
}

export async function redo(): Promise<void> {
  return jump(() => engine.redo())
}
