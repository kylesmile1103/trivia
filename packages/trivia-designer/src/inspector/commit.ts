// The inspector's only write path: one updateProp through the action bus, so history,
// selection follow-up and error toasts behave like every other edit.

import type { JsonValue, NodeDetails } from '@/bridge/types'
import { dispatch } from '@/state/actions'

import { propLabel } from './model'

/** Write one prop of the inspected node (`null` removes it). False when the engine refused;
 *  the action bus has already reported why. */
export type CommitProp = (prop: string, value: JsonValue) => Promise<boolean>

export async function commitProp(details: NodeDetails, prop: string, value: JsonValue): Promise<boolean> {
  const result = await dispatch(
    { op: 'updateProp', target: details.locator, expectedName: details.name, prop, value },
    propLabel(details.name, prop, value),
  )
  return result !== null
}
