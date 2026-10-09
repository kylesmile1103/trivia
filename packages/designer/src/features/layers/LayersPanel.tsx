// The layers panel: the rendered app's element tree as the canvas selects it (usage sites,
// nested as rendered; shared/canvas.ts `layers()`). A row selects its element on click and
// highlights it on the canvas on hover; the selection's row is revealed and marked. The tree is
// re-read after every re-render (store.revision) and selection change.
//
// Rows move elements in the source. Drag one onto another: before it, after it or inside it as
// its first child (./drop.ts says which, from where on the row it is dropped); Alt+↑/↓ moves the
// focused row past a sibling. The canvas makes the edit (canvas.move / moveStep) with the version
// the tree was read at, so a tree that has gone stale is refused rather than misread.

import { ChevronRightIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { canvas, type Layer, type MovePlacement } from '@/shared/canvas'
import { isRootLocator } from '@/shared/lib/locator'
import { cn } from '@/shared/lib/utils'
import { designer, useDesigner } from '@/shared/state/store'

import { dropPlacement } from './drop'

/** The drag data type of a layer row; other drags (palette templates) pass over the panel. */
const LAYER_MIME = 'application/x-trivia-layer'

interface Dragged {
  locator: string
  /** The dragged layer and everything under it: no drop lands there. */
  blocked: ReadonlySet<string>
  version: number
}

export function LayersPanel() {
  const revision = useDesigner((s) => s.revision)
  const selected = useDesigner((s) => s.selected)
  const hovered = useDesigner((s) => s.hovered)
  // The tree and the canvas version it was read at, together.
  const [{ layers, version }, setTree] = useState(() => ({ layers: canvas.layers(), version: canvas.version() }))
  /** Rows the user collapsed; everything else is open. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const dragged = useRef<Dragged | null>(null)
  const [drop, setDrop] = useState<{ locator: string; placement: MovePlacement } | null>(null)
  /** A keyboard move is landing: focus the selection's row once the tree shows it. */
  const refocus = useRef(false)

  useEffect(() => setTree({ layers: canvas.layers(), version: canvas.version() }), [revision, selected])

  useEffect(() => {
    if (!refocus.current || selected === null) return
    const el = document.querySelector<HTMLElement>(`[data-layer="${CSS.escape(selected)}"]`)
    if (el) {
      refocus.current = false
      el.focus()
    }
  }, [layers, selected])

  // The selection's ancestors stay open, so its row can always be seen.
  const path = useMemo(() => (selected === null ? new Set<string>() : new Set(ancestorsOf(layers, selected))), [layers, selected])

  useEffect(() => {
    if (selected === null) return
    document.querySelector(`[data-layer="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected, layers])

  const toggle = (locator: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(locator)) next.add(locator)
      return next
    })

  const endDrag = () => {
    dragged.current = null
    setDrop(null)
  }

  /** Where a drag over `layer`'s row would land, or null when it can't land there. */
  const landing = (e: React.DragEvent, layer: Layer, open: boolean): MovePlacement | null => {
    const d = dragged.current
    if (d === null || !e.dataTransfer.types.includes(LAYER_MIME) || d.blocked.has(layer.locator)) return null
    const box = e.currentTarget.getBoundingClientRect()
    return dropPlacement(e.clientY - box.top, box.height, {
      root: isRootLocator(layer.locator),
      hasChildren: layer.children.length > 0,
      expanded: open,
    })
  }

  if (layers.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Nothing on the canvas carries a locator yet.</p>
  }

  const rows = (list: Layer[], depth: number): React.ReactNode =>
    list.map((layer) => {
      const open = layer.children.length > 0 && (!collapsed.has(layer.locator) || path.has(layer.locator))
      return (
        <li key={layer.locator} role="none">
          <div
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={layer.locator === selected}
            aria-expanded={layer.children.length > 0 ? open : undefined}
            aria-label={[layer.name, layer.text, layer.count > 1 ? `×${layer.count}` : null].filter(Boolean).join(' ')}
            data-layer={layer.locator}
            data-drop={drop?.locator === layer.locator ? drop.placement : undefined}
            tabIndex={layer.locator === selected ? 0 : -1}
            draggable
            className={cn(
              'group relative flex h-7 cursor-default items-center gap-1 rounded-md pr-2 text-xs select-none',
              layer.locator === selected
                ? 'bg-primary/10 text-foreground'
                : layer.locator === hovered
                  ? 'bg-accent/60'
                  : 'hover:bg-accent/60',
              drop?.locator === layer.locator && drop.placement === 'inside' && 'bg-primary/15 ring-1 ring-primary ring-inset',
            )}
            style={{ paddingLeft: 4 + depth * 12 }}
            onClick={() => designer.getState().select(layer.locator)}
            onDragStart={(e) => {
              const refusal = canvas.moveRefusal(layer.locator)
              if (refusal !== null) {
                e.preventDefault()
                toast.error(`Can't move <${layer.name}>: ${refusal}.`)
                return
              }
              e.dataTransfer.setData(LAYER_MIME, layer.locator)
              e.dataTransfer.effectAllowed = 'move'
              dragged.current = { locator: layer.locator, blocked: new Set(subtree(layer)), version }
            }}
            onDragOver={(e) => {
              const placement = landing(e, layer, open)
              if (placement === null) {
                if (drop?.locator === layer.locator) setDrop(null)
                return
              }
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (drop?.locator !== layer.locator || drop.placement !== placement) setDrop({ locator: layer.locator, placement })
            }}
            onDrop={(e) => {
              const placement = landing(e, layer, open)
              const d = dragged.current
              endDrag()
              if (placement === null || d === null) return
              e.preventDefault()
              void canvas.move(d.locator, layer.locator, placement, d.version)
            }}
            onDragEnd={endDrag}
            onKeyDown={(e) => {
              if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault()
                refocus.current = true
                void canvas.moveStep(layer.locator, e.key === 'ArrowUp' ? 'up' : 'down', version)
              } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                designer.getState().select(layer.locator)
              } else if ((e.key === 'ArrowLeft' && open) || (e.key === 'ArrowRight' && !open && layer.children.length > 0)) {
                e.preventDefault()
                toggle(layer.locator)
              }
            }}
            onMouseEnter={() => designer.getState().hover(layer.locator)}
            onMouseLeave={() => {
              if (designer.getState().hovered === layer.locator) designer.getState().hover(null)
            }}
          >
            {layer.children.length > 0 ? (
              <button
                type="button"
                aria-hidden // the row is the treeitem: ←/→ collapse and expand it
                title={open ? 'Collapse' : 'Expand'}
                tabIndex={-1}
                className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  toggle(layer.locator)
                }}
              >
                <ChevronRightIcon className={cn('size-3 transition-transform', open && 'rotate-90')} />
              </button>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <span className="shrink-0 font-mono">{layer.name}</span>
            {layer.text && <span className="min-w-0 truncate text-muted-foreground">{layer.text}</span>}
            {layer.count > 1 && (
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums" title={`Rendered ${layer.count} times`}>
                ×{layer.count}
              </span>
            )}
            {drop?.locator === layer.locator && drop.placement !== 'inside' && (
              <span
                aria-hidden
                className={cn('pointer-events-none absolute right-1 h-0.5 rounded-full bg-primary', drop.placement === 'before' ? '-top-px' : '-bottom-px')}
                style={{ left: 4 + depth * 12 }}
              />
            )}
          </div>
          {open && (
            <ul role="group" className="m-0 list-none p-0">
              {rows(layer.children, depth + 1)}
            </ul>
          )}
        </li>
      )
    })

  return (
    <div className="min-h-0 overflow-y-auto px-2 py-1 [scrollbar-width:thin]">
      <ul
        role="tree"
        aria-label="Layers"
        className="m-0 list-none p-0"
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null)
        }}
      >
        {rows(layers, 0)}
      </ul>
    </div>
  )
}

/** `layer`'s locator and those of everything under it. */
function subtree(layer: Layer): string[] {
  return [layer.locator, ...layer.children.flatMap(subtree)]
}

/** Locators of the layers above `locator`, outermost first; empty when it isn't in the tree. */
function ancestorsOf(layers: readonly Layer[], locator: string): string[] {
  for (const layer of layers) {
    if (layer.locator === locator) return []
    const below = ancestorsOf(layer.children, locator)
    if (below.length > 0 || layer.children.some((c) => c.locator === locator)) return [layer.locator, ...below]
  }
  return []
}
