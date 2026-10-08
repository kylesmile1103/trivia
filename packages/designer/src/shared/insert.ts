// Template → source, for the palette and the Data panel: click-to-insert into the selection,
// and the drag payload the canvas drop handler reads.

import { toast } from 'sonner'

import { engine } from '@/shared/engine/client'
import type { NodeDetails, Placement } from '@/shared/engine/types'
import { dispatch, dispatchBatch } from '@/shared/state/actions'
import { designer } from '@/shared/state/store'
import { TEMPLATE_MIME, type Template, templateOps } from '@/shared/template'

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
  // The name the user saw selected: if the selection's position has since moved to another
  // node, the engine refuses (409) instead of inserting next to the wrong one.
  const ops = templateOps(template, { target: selected, expectedName: node.name, placement, childCount: node.children.length })
  const label = `Insert ${template.label} ${where} <${node.name}>`
  const [only] = ops
  await (ops.length === 1 && only ? dispatch(only, label) : dispatchBatch(ops, label))
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
