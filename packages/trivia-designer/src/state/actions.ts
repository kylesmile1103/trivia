// The action bus: every change to user code goes through `dispatch`, so history, selection
// follow-up and error reporting behave the same for clicks, drags, setters and (later) agents.

import { toast } from 'sonner'

import { ApiError, engine } from '@/bridge/client'
import type { ApplyResult, Op } from '@/bridge/types'
import { designer } from '@/state/store'

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
  try {
    const result = await call()
    const s = designer.getState()
    s.setHistory(result.history)
    if (result.locator) s.select(result.locator)
    else if (last?.op === 'remove') s.select(null)
    return result
  } catch (error) {
    report(error)
    return null
  }
}

export async function undo(): Promise<void> {
  try {
    const r = await engine.undo()
    designer.getState().setHistory(r.history)
  } catch (error) {
    report(error)
  }
}

export async function redo(): Promise<void> {
  try {
    const r = await engine.redo()
    designer.getState().setHistory(r.history)
  } catch (error) {
    report(error)
  }
}
