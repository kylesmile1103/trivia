// What the designer has selected, as it last said, so an agent can act on "this" (docs/mcp.md).
// The designer posts every change; an agent's edit moves the stored selection along with the
// node it was on (the engine follows it through the edit, service.ts `#follow`, then it is
// checked by tag name), and the designer adopts that on its next sync.

export interface Selected {
  locator: string
  /** The tag name at `locator` when it was selected: what ops send as `expectedName`. */
  name: string
}

export interface SelectionState {
  /** null: nothing is selected (or no designer has said yet). */
  selection: Selected | null
  /** Bumped on every change. */
  version: number
  /** Who made the last change; null before anyone has. */
  by: 'designer' | 'agent' | null
}

export class SelectionStore {
  #state: SelectionState = { selection: null, version: 0, by: null }

  get(): SelectionState {
    return this.#state
  }

  /** Record a new selection. Repeating the current one changes nothing (not even `by`). */
  set(selection: Selected | null, by: 'designer' | 'agent'): SelectionState {
    const current = this.#state.selection
    const same =
      selection === null ? current === null : current !== null && current.locator === selection.locator && current.name === selection.name
    if (!same) this.#state = { selection, version: this.#state.version + 1, by }
    return this.#state
  }
}
