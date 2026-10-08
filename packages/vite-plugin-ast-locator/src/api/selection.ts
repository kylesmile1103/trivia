// What the designer has selected, as it last said, so an agent can act on "this" (docs/mcp.md).
// The designer posts every change; an agent's edit moves the stored selection along with the
// node it was on (`rebase`, then checked by tag name), and the designer adopts that on its
// next sync.

import type { Json } from './service.js'

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

interface Parsed {
  /** `<file>#<component>`: only nodes under the same one shift. */
  scope: string
  path: number[]
}

function parse(locator: unknown): Parsed | null {
  if (typeof locator !== 'string') return null
  const last = locator.lastIndexOf('#')
  const mid = last > 0 ? locator.lastIndexOf('#', last - 1) : -1
  if (mid <= 0) return null
  const segments = locator.slice(last + 1).split('.')
  if (!segments.every((s) => /^(0|[1-9]\d*)$/.test(s))) return null
  return { scope: locator.slice(0, last), path: segments.map(Number) }
}

const format = ({ scope, path }: Parsed) => `${scope}#${path.join('.')}`

/** True when `node` is `at`'s node or inside its subtree. */
function within(node: Parsed, at: Parsed): boolean {
  return node.scope === at.scope && node.path.length >= at.path.length && at.path.every((seg, i) => node.path[i] === seg)
}

/**
 * Shift `node` for one element appearing (`delta` 1) or disappearing (-1) at `at`: siblings
 * from `at`'s index on (and their subtrees) move by `delta` at that depth.
 */
function shift(node: Parsed, at: Parsed, delta: 1 | -1): Parsed {
  const depth = at.path.length - 1
  const index = at.path[depth]!
  const sameParent = node.scope === at.scope && node.path.length > depth && at.path.slice(0, depth).every((seg, i) => node.path[i] === seg)
  const own = node.path[depth]!
  if (!sameParent || (delta === 1 ? own < index : own <= index)) return node
  return { scope: node.scope, path: node.path.map((seg, i) => (i === depth ? seg + delta : seg)) }
}

/**
 * Where the node at `locator` is after `op` produced `result` (its result locator), or null
 * when the op removed it or its place can't be known. Locators are positions, and each op
 * adds, removes or moves exactly one element, so this is arithmetic on index paths; callers
 * still check the tag name at the answer before trusting it.
 */
export function rebase(locator: string, op: Json, result: string | null): string | null {
  const node = parse(locator)
  if (node === null) return null
  switch (op['op']) {
    case 'updateProp':
    case 'setText':
    case 'bindQuery':
      return locator
    case 'insert':
    case 'insertChild': {
      const inserted = parse(result)
      return inserted === null ? null : format(shift(node, inserted, 1))
    }
    case 'remove': {
      const removed = parse(op['target'])
      if (removed === null || within(node, removed)) return null
      return format(shift(node, removed, -1))
    }
    case 'replaceElement': {
      // One element for another in its place: it keeps its locator, what was inside it is gone.
      const replaced = parse(op['target'])
      if (replaced === null) return null
      return within(node, replaced) && node.path.length > replaced.path.length ? null : locator
    }
    case 'move':
    case 'moveNode': {
      const source = parse(op['source'])
      const landed = parse(result)
      if (source === null || landed === null) return null
      // The moved subtree goes along; everything else sees one removal, then one insertion.
      if (within(node, source)) return format({ scope: landed.scope, path: [...landed.path, ...node.path.slice(source.path.length)] })
      return format(shift(shift(node, source, -1), landed, 1))
    }
    default:
      return null
  }
}
