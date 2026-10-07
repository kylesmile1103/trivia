// The action bus: every change to user code goes through `dispatch`, so history, selection
// follow-up and error reporting behave the same for clicks, drags, setters and (later) agents.

import { toast } from 'sonner'

import { ApiError, engine } from '@/bridge/client'
import type { ApplyResult, Op } from '@/bridge/types'
import { designer } from '@/state/store'

/** Edits sent to the engine (apply, batch, undo, redo) that haven't answered yet. */
let inFlight = 0

/**
 * True while an edit is on its way to disk. Its file may already be written, so a locator read
 * from the canvas, and any engine lookup for it, can disagree from that moment until HMR has
 * re-rendered the app. The store's `history` changes when the edit lands, before this clears.
 */
export function isApplying(): boolean {
  return inFlight > 0
}

function report(error: unknown): void {
  const message = error instanceof ApiError ? error.message : String(error)
  toast.error(message)
}

/** Apply one op (one undo entry). Selects the affected node afterwards. */
export async function dispatch(op: Op, label: string): Promise<ApplyResult | null> {
  return run(() => engine.apply(op, label), op)
}

/** Apply several ops as one transaction (one undo entry), e.g. a gesture. */
export async function dispatchBatch(ops: Op[], label: string): Promise<ApplyResult | null> {
  return run(() => engine.batch(ops, label), ops[ops.length - 1])
}

async function run(call: () => Promise<ApplyResult>, last: Op | undefined): Promise<ApplyResult | null> {
  inFlight++
  try {
    const result = await call()
    const s = designer.getState()
    // A new `history` tells the canvas an HMR is on its way; an unchanged result writes
    // nothing and adds no entry (docs/api.md), so there is nothing to wait for.
    if (result.changed) s.setHistory(result.history)
    if (result.locator) s.select(result.locator)
    else if (last?.op === 'remove') s.select(null)
    return result
  } catch (error) {
    report(error)
    return null
  } finally {
    inFlight--
  }
}

/** Remember what is selected so a history jump can't silently retarget the selection. */
function guardSelection(): void {
  const s = designer.getState()
  const name = s.details && s.details.locator === s.selected ? s.details.name : null
  if (name !== null) s.expectSelectedName(name)
}

export async function undo(): Promise<void> {
  guardSelection()
  inFlight++
  try {
    const r = await engine.undo()
    designer.getState().setHistory(r.history)
  } catch (error) {
    report(error)
  } finally {
    inFlight--
  }
}

export async function redo(): Promise<void> {
  guardSelection()
  inFlight++
  try {
    const r = await engine.redo()
    designer.getState().setHistory(r.history)
  } catch (error) {
    report(error)
  } finally {
    inFlight--
  }
}
