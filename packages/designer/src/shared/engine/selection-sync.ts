// The designer's half of point-and-ask (docs/mcp.md). It tells the plugin what the user
// selected, so an agent asked about "this" knows what it is, and it takes the selection back
// when an agent's edit moved it (the plugin re-points it at the element's new locator).

import { designer, type DesignerState } from '@/shared/state/store'

import { engine } from './client'
import type { SelectionState } from './types'

type Selected = NonNullable<SelectionState['selection']>

/** What the plugin was last told or last showed ('' for nothing); undefined: unknown. */
let known: string | undefined
/** The plugin's newest selection version this designer has seen. */
let seen = 0

const keyOf = (selection: Selected | null) => (selection === null ? '' : `${selection.locator}\n${selection.name}`)

/** Publish every selection change; returns the unsubscribe function. */
export function startSelectionSync(): () => void {
  publish(designer.getState())
  return designer.subscribe((s, prev) => {
    if (s.selected === prev.selected && s.details === prev.details) return
    // The re-render guard (store `setDetails`) found another element at the selected locator.
    // That says the designer no longer knows what is selected, not that the user selected
    // nothing: the plugin may know better (an agent's edit moved it), so it isn't told.
    const dropped = s.selected === null && prev.selected !== null && prev.expectedSelectedName !== null
    if (!dropped) publish(s)
  })
}

function publish(s: Pick<DesignerState, 'selected' | 'details'>): void {
  let selection: Selected | null
  if (s.selected === null) selection = null
  else if (s.details !== null && s.details.locator === s.selected) selection = { locator: s.selected, name: s.details.name }
  else return // the inspector hasn't named it yet
  const key = keyOf(selection)
  if (key === known) return
  known = key
  engine.select(selection).then(
    (state) => {
      seen = Math.max(seen, state.version)
    },
    () => {
      known = undefined // try again with the next change
    },
  )
}

/** Read the plugin's selection and adopt an agent's change to it. */
export async function syncSelection(): Promise<void> {
  adopt(await engine.selection())
}

function adopt(state: SelectionState): void {
  if (state.version < seen) {
    // A new dev server: it knows nothing yet, so tell it what is selected.
    seen = state.version
    known = undefined
    publish(designer.getState())
    return
  }
  if (state.version === seen) return
  seen = state.version
  if (state.by !== 'agent') return
  known = keyOf(state.selection)
  const target = state.selection?.locator ?? null
  const s = designer.getState()
  if (s.selected !== target) s.select(target)
}

/** Forget what was posted and seen (tests). */
export function resetSelectionSync(): void {
  known = undefined
  seen = 0
}
