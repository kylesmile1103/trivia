// Where a layer dragged in the layers panel lands, from where on a row the pointer is.

import type { MovePlacement } from '@/shared/canvas'

export interface DropRow {
  /** The row is a component's root: the engine has no sibling slot for it, only inside. */
  root: boolean
  hasChildren: boolean
  /** Its children are listed right below it. */
  expanded: boolean
}

/**
 * The top quarter of a row is before it, the bottom quarter after it, the middle inside it (as
 * its first child). A leaf splits in halves: nothing says it can hold children (the canvas
 * drops into an empty container). An open row's bottom edge touches its first child, so it means
 * inside there too.
 */
export function dropPlacement(y: number, height: number, row: DropRow): MovePlacement {
  if (row.root) return 'inside'
  if (!row.hasChildren) return y < height / 2 ? 'before' : 'after'
  if (y < height / 4) return 'before'
  return !row.expanded && y > (height * 3) / 4 ? 'after' : 'inside'
}
