// The inspector's only write path: one updateProp through the action bus, so history,
// selection follow-up and error toasts behave like every other edit.
//
// One case skips the bus's selection follow-up: an edit committed after the user selected
// something else (a field committing as its element is left; see ./leave). The edit still
// targets the node it was typed for — its locator and expectedName — but the bus would select
// that node again once the write returns, pulling the selection back from where the user just
// put it. So that edit is applied directly, with the bus's history update and an error toast
// that names it.

import { toast } from 'sonner'

import { ApiError, engine } from '@/bridge/client'
import type { JsonValue, NodeDetails, Op } from '@/bridge/types'
import { dispatch } from '@/state/actions'
import { designer } from '@/state/store'

import { selectionLeft } from './leave'
import { propLabel } from './model'

/** Write one prop of the inspected node (`null` removes it); `label` names the history entry
 *  (default "Set Button.variant"). False when the engine refused; the user has been told why. */
export type CommitProp = (prop: string, value: JsonValue, label?: string) => Promise<boolean>

export async function commitProp(details: NodeDetails, prop: string, value: JsonValue, label?: string): Promise<boolean> {
  const op: Op = { op: 'updateProp', target: details.locator, expectedName: details.name, prop, value }
  const name = label ?? propLabel(details.name, prop, value)
  if (selectionLeft(details.locator)) return applyAfterLeaving(op, name)
  return (await dispatch(op, name)) !== null
}

async function applyAfterLeaving(op: Op, label: string): Promise<boolean> {
  try {
    const result = await engine.apply(op, label)
    designer.getState().setHistory(result.history)
    return true
  } catch (error) {
    // The user is looking at another element by now: say which edit failed.
    toast.error(`Couldn’t apply “${label}”: ${error instanceof ApiError ? error.message : String(error)}`)
    return false
  }
}
