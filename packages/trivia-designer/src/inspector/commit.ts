// The inspector's only write path: one updateProp through the action bus, so history,
// selection follow-up, the canvas's in-flight bookkeeping and error toasts behave like every
// other edit.
//
// An edit committed after the user selected something else (a field committing as its element
// is left; see ./leave) still targets the node it was typed for (its locator and expectedName),
// but skips the bus's selection follow-up, which would select that node again once the write
// returns and pull the selection back from where the user just put it.

import type { JsonValue, NodeDetails, Op } from '@/bridge/types'
import { dispatch } from '@/state/actions'

import { selectionLeft } from './leave'
import { propLabel } from './model'

/** Write one prop of the inspected node (`null` removes it); `label` names the history entry
 *  (default "Set Button.variant"). False when the engine refused; the user has been told why. */
export type CommitProp = (prop: string, value: JsonValue, label?: string) => Promise<boolean>

export async function commitProp(details: NodeDetails, prop: string, value: JsonValue, label?: string): Promise<boolean> {
  const op: Op = { op: 'updateProp', target: details.locator, expectedName: details.name, prop, value }
  const name = label ?? propLabel(details.name, prop, value)
  return (await dispatch(op, name, { follow: !selectionLeft(details.locator) })) !== null
}
