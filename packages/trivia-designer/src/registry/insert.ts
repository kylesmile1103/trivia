// Palette → source: click-to-insert and the drag payload the canvas drop handler reads.

import { toast } from 'sonner'

import { engine } from '@/bridge/client'
import type { NodeDetails, Placement } from '@/bridge/types'
import type { Template } from '@/registry/templates'
import { dispatch } from '@/state/actions'
import { designer } from '@/state/store'

/** dataTransfer type carrying a JSON `Template` (read by the canvas on drop). */
export const TEMPLATE_MIME = 'application/x-trivia-template'

/** HTML void elements: inserting children into them produces invalid markup. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'textarea',
])

/**
 * Where a click-insert lands relative to the selected node: inside it, as its last child,
 * unless it can't hold children (`<Input />`, `<img>`), in which case right after it.
 */
export function placementFor(node: Pick<NodeDetails, 'name'>, acceptsChildren: boolean | undefined): Placement {
  if (acceptsChildren === false || VOID_TAGS.has(node.name)) return 'after'
  return 'lastChild'
}

/** Insert `template` into (or after) the selected node, as one undoable edit. */
export async function insertIntoSelection(template: Template): Promise<void> {
  const { selected, details, componentsByName } = designer.getState()
  if (selected === null) {
    toast.info('Select an element on the canvas first', {
      description: `${template.label} will be added inside it. You can also drag it onto the canvas.`,
    })
    return
  }
  let node: NodeDetails
  try {
    node = details?.locator === selected ? details : await engine.inspect(selected)
  } catch (error) {
    toast.error(`Can't insert ${template.label}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const placement = placementFor(node, componentsByName[node.name]?.acceptsChildren)
  const where = placement === 'after' ? 'after' : 'into'
  await dispatch(
    { op: 'insert', target: selected, placement, snippet: template.snippet, imports: template.imports },
    `Insert ${template.label} ${where} <${node.name}>`,
  )
}

/** Start a palette drag: the store says what is being dragged, dataTransfer carries it. */
export function startTemplateDrag(event: DragEvent, template: Template): void {
  const data = event.dataTransfer
  if (data === null) return
  data.effectAllowed = 'copy'
  data.setData(TEMPLATE_MIME, JSON.stringify(template))
  // Dropped into a code editor (or any text field), the drag yields the markup itself.
  data.setData('text/plain', template.snippet)
  setDragImage(data, template.label)
  designer.getState().setDrag({ kind: 'palette', template })
}

export function endTemplateDrag(): void {
  designer.getState().setDrag(null)
}

/** A compact chip as the drag image instead of a ghost of the whole palette row. */
function setDragImage(data: DataTransfer, label: string): void {
  const chip = document.createElement('div')
  chip.textContent = label
  chip.className =
    'fixed -top-96 left-0 rounded-md border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-md'
  document.body.append(chip)
  data.setDragImage(chip, -10, -10)
  // The browser snapshots the image synchronously during dragstart.
  requestAnimationFrame(() => chip.remove())
}
