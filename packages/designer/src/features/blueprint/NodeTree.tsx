import { useRef, useState, type DragEvent } from 'react'

import type { MovePlacement } from '@/shared/canvas'
import type { BlueprintComponent, BlueprintComponents, BlueprintDocument, BlueprintNode, BlueprintNodePosition, CustomPage } from '@/shared/engine/types'
import { dropPlacement } from '@/shared/lib/tree-drop'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

import { Field, selectClass } from './fields'
import type { SaveBlueprintOp } from './PageForm'

type Destination = { parent: string; slot: string } & BlueprintNodePosition
type Entry = [string, BlueprintNode]
type Row = { entry: Entry; depth: number }

function slotsFor(components: BlueprintComponent[], parent: BlueprintNode, child?: string) {
  return (components.find(({ type }) => type === parent.type)?.slots ?? []).filter((slot) =>
    slot.kind === 'nodes' && (child === undefined || slot.accepts === undefined || slot.accepts.includes(child)))
}

export function destinationFor(page: CustomPage, components: BlueprintComponent[], source: string, target: string, placement: MovePlacement, intoSlot?: string): Destination | null {
  const node = page.nodes[source]
  const anchor = page.nodes[target]
  if (!node?.parent || !anchor || source === target) return null
  const parentId = placement === 'inside' ? target : anchor.parent
  if (parentId === null) return null
  const parent = page.nodes[parentId]
  if (!parent) return null
  const seen = new Set([source])
  for (let id: string | null = parentId; id !== null; id = page.nodes[id]?.parent ?? null) {
    if (seen.has(id)) return null
    seen.add(id)
  }
  const slots = slotsFor(components, parent, node.type)
  if (placement === 'inside') {
    const slot = intoSlot ?? slots.find(({ name }) => name === 'children')?.name ?? slots[0]?.name
    return slot && slots.some(({ name }) => name === slot) ? { parent: parentId, slot, index: 0 } : null
  }
  const slot = anchor.slot
  if (!slot || !slots.some(({ name }) => name === slot)) return null
  return placement === 'before' ? { parent: parentId, slot, before: target } : { parent: parentId, slot, after: target }
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const slotOrder = (name: string | null) => name === 'children' ? '' : name ?? ''

function treeRows(page: CustomPage, collapsed: ReadonlySet<string>) {
  const children = new Map<string, Entry[]>()
  for (const entry of Object.entries(page.nodes)) {
    const { parent } = entry[1]
    if (parent === null) continue
    const siblings = children.get(parent) ?? []
    siblings.push(entry)
    children.set(parent, siblings)
  }
  const root = page.nodes[page.root]
  const pending: Row[] = root ? [{ entry: [page.root, root], depth: 0 }] : []
  const rows: Row[] = []
  const seen = new Set<string>()
  for (let row = pending.pop(); row; row = pending.pop()) {
    const [id] = row.entry
    if (seen.has(id)) continue
    seen.add(id)
    rows.push(row)
    if (collapsed.has(id)) continue
    const siblings = children.get(id) ?? []
    siblings.sort(([leftId, left], [rightId, right]) =>
      compare(slotOrder(right.slot), slotOrder(left.slot)) || compare(right.order, left.order) || compare(rightId, leftId))
    for (const entry of siblings) pending.push({ entry, depth: row.depth + 1 })
  }
  return { rows, children }
}

interface NodeTreeProps {
  document: BlueprintDocument<CustomPage>
  catalog: BlueprintComponents
  selected: string
  busy?: boolean
  onSelect(node: string): void
  save: SaveBlueprintOp
}

export function NodeTree({ document: { doc, rev, path }, catalog, selected, busy = false, onSelect, save }: NodeTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [drop, setDrop] = useState<{ id: string; placement: MovePlacement } | null>(null)
  const drag = useRef<{ id: string; rev: string } | null>(null)
  const { rows, children } = treeRows(doc, collapsed)
  const current = doc.nodes[selected]
  const components = catalog.components

  function move(source: string, destination: Destination) {
    const node = doc.nodes[source]
    if (node) void save({
      op: 'moveNode', doc: path, baseRev: rev, node: source, expectedType: node.type, ...destination,
    }, `Blueprint: move ${node.name} in ${doc.name}`)
  }

  function landing(event: DragEvent, id: string, node: BlueprintNode, expanded: boolean) {
    const source = drag.current
    if (busy || !source || source.rev !== rev) return null
    const box = event.currentTarget.getBoundingClientRect()
    const placement = dropPlacement(event.clientY - box.top, box.height, {
      root: id === doc.root, hasChildren: slotsFor(components, node).length > 0, expanded,
    })
    const destination = destinationFor(doc, components, source.id, id, placement)
    return destination && { source: source.id, placement, destination }
  }

  return (
    <section aria-label="Blueprint nodes" className="space-y-2">
      <h3 className="text-xs font-semibold">Nodes</h3>
      <ul className="space-y-0.5">
        {rows.map(({ entry: [id, node], depth }) => {
          const canCollapse = children.has(id)
          const expanded = canCollapse && !collapsed.has(id)
          return (
            <li key={id} className="relative flex items-center gap-0.5" style={{ paddingInlineStart: Math.min(depth, 12) * 9 }}>
              {canCollapse && (
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name}`}
                  aria-expanded={expanded} onClick={() => setCollapsed((previous) => {
                    const next = new Set(previous)
                    if (!next.delete(id)) next.add(id)
                    return next
                  })}>{expanded ? '−' : '+'}</Button>
              )}
              <button
                type="button" data-bp-tree-node={id} data-pointer={`/nodes/${id}`}
                aria-pressed={selected === id} disabled={busy} draggable={!busy && id !== doc.root}
                className={cn(
                  'relative flex min-w-0 flex-1 items-baseline gap-1 rounded-sm border-y border-transparent px-1.5 py-1 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                  selected === id && 'bg-primary/10',
                  drop?.id === id && drop.placement === 'inside' && 'ring-1 ring-primary',
                  drop?.id === id && drop.placement === 'before' && 'border-t-primary',
                  drop?.id === id && drop.placement === 'after' && 'border-b-primary',
                )}
                aria-label={`Select ${node.name} (${node.type})`} onClick={() => onSelect(id)}
                onDragStart={(event) => {
                  if (id === doc.root || busy) { event.preventDefault(); return }
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('application/x-trivia-blueprint-node', id)
                  drag.current = { id, rev }
                }}
                onDragOver={(event) => {
                  const target = landing(event, id, node, expanded)
                  if (target) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }
                  setDrop(target && { id, placement: target.placement })
                }}
                onDragLeave={() => setDrop((previous) => previous?.id === id ? null : previous)}
                onDragEnd={() => { drag.current = null; setDrop(null) }}
                onDrop={(event) => {
                  const target = landing(event, id, node, expanded)
                  drag.current = null
                  setDrop(null)
                  if (!target) return
                  event.preventDefault()
                  move(target.source, target.destination)
                }}
              >
                <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{node.name}</span>
                <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
                  {node.type}{node.slot && node.slot !== 'children' ? ` · ${node.slot}` : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {current && (
        <>
          <AddNode key={selected} page={doc} selected={current} components={components} busy={busy} onAdd={(type, name, slot) => save({
            op: 'addNode', doc: path, baseRev: rev, parent: selected, expectedType: current.type, type, name, slot,
          }, `Blueprint: add ${name} to ${doc.name}`)} />
          {selected !== doc.root && (
            <div className="space-y-2">
              <MoveNode key={selected} page={doc} selected={selected} components={components} busy={busy} onMove={(destination) => move(selected, destination)} />
              <Button type="button" size="xs" variant="destructive" disabled={busy} onClick={() => void save({
                op: 'removeNode', doc: path, baseRev: rev, node: selected, expectedType: current.type,
              }, `Blueprint: remove ${current.name} from ${doc.name}`)}>Remove node</Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function AddNode({ page, selected, components, busy, onAdd }: {
  page: CustomPage; selected: BlueprintNode; components: BlueprintComponent[]; busy: boolean
  onAdd(type: string, name: string, slot: string): Promise<boolean>
}) {
  const [slot, setSlot] = useState('')
  const [type, setType] = useState('')
  const slots = slotsFor(components, selected)
  if (!slots.length) return null
  const current = slots.find(({ name }) => name === slot) ?? slots[0]!
  const choices = components.filter((component) => current.accepts === undefined || current.accepts.includes(component.type))
  const validType = choices.some((component) => component.type === type) ? type : ''
  const base = 'node' + type.charAt(0).toUpperCase() + type.slice(1)
  const names = new Set([...Object.values(page.nodes).map((node) => node.name), ...Object.keys(page.state), ...Object.keys(page.queries)])
  let suggested = base
  for (let suffix = 2; names.has(suggested); suffix++) suggested = base + suffix

  return (
    <form aria-label="Add node" className="space-y-2 border-t pt-2" onSubmit={(event) => {
      event.preventDefault()
      if (!validType) return
      const input = new FormData(event.currentTarget).get('blueprintNodeName')
      const name = String(input ?? '').trim() || suggested
      void onAdd(validType, name, current.name).then((saved) => { if (saved) setType('') })
    }}>
      <fieldset disabled={busy} className="grid gap-2">
        {slots.length > 1 && <Field label="Slot">{(id) => (
          <select id={id} className={selectClass} value={current.name} onChange={(event) => setSlot(event.target.value)}>
            {slots.map(({ name }) => <option key={name}>{name}</option>)}
          </select>
        )}</Field>}
        <Field label="Component">{(id) => (
          <select id={id} name="component" className={selectClass} value={validType} onChange={(event) => setType(event.target.value)}>
            <option value="">Choose a component</option>
            {choices.map((component) => <option key={component.type} value={component.type}>{component.type}{component.installed ? '' : ' (not installed)'}</option>)}
          </select>
        )}</Field>
        {validType && <Field label="Node name">{(id) => <Input id={id} name="blueprintNodeName" pattern="[a-z][A-Za-z0-9]*" placeholder={suggested} />}</Field>}
        <Button type="submit" size="xs" variant="outline" disabled={!validType}>Add node</Button>
      </fieldset>
    </form>
  )
}

function MoveNode({ page, selected, components, busy, onMove }: {
  page: CustomPage; selected: string; components: BlueprintComponent[]; busy: boolean; onMove(destination: Destination): void
}) {
  const [placement, setPlacement] = useState<MovePlacement>('inside')
  const [target, setTarget] = useState('')
  const [slot, setSlot] = useState('')
  const node = page.nodes[target]
  const slots = placement === 'inside' && node ? slotsFor(components, node, page.nodes[selected]?.type) : []
  const destination = destinationFor(page, components, selected, target, placement, slots.some(({ name }) => name === slot) ? slot : undefined)
  return (
    <details className="space-y-2 text-xs">
      <summary className="cursor-pointer">Move node</summary>
      <fieldset disabled={busy} className="grid gap-2">
        <Field label="Position">{(id) => (
          <select id={id} className={selectClass} value={placement} onChange={(event) => setPlacement(event.target.value as MovePlacement)}>
            <option value="before">Before</option><option value="after">After</option><option value="inside">Inside</option>
          </select>
        )}</Field>
        <Field label="Target node">{(id) => (
          <select id={id} className={selectClass} value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">Choose a node</option>
            {Object.entries(page.nodes).filter(([id]) => id !== selected).map(([id, node]) => (
              <option key={id} value={id} disabled={!destinationFor(page, components, selected, id, placement)}>{node.name}</option>
            ))}
          </select>
        )}</Field>
        {slots.length > 1 && <Field label="Destination slot">{(id) => (
          <select id={id} className={selectClass} value={destination?.slot ?? ''} onChange={(event) => setSlot(event.target.value)}>
            {slots.map(({ name }) => <option key={name}>{name}</option>)}
          </select>
        )}</Field>}
        <Button type="button" size="xs" variant="outline" disabled={!destination} onClick={() => { if (destination) onMove(destination) }}>Move</Button>
      </fieldset>
    </details>
  )
}
