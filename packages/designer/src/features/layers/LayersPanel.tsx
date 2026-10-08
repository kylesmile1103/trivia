// The layers panel: the rendered app's element tree as the canvas selects it (usage sites,
// nested as rendered; shared/canvas.ts `layers()`). A row selects its element on click and
// highlights it on the canvas on hover; the selection's row is revealed and marked. The tree is
// re-read after every re-render (store.revision) and selection change.

import { ChevronRightIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { canvas, type Layer } from '@/shared/canvas'
import { cn } from '@/shared/lib/utils'
import { designer, useDesigner } from '@/shared/state/store'

export function LayersPanel() {
  const revision = useDesigner((s) => s.revision)
  const selected = useDesigner((s) => s.selected)
  const hovered = useDesigner((s) => s.hovered)
  const [layers, setLayers] = useState<Layer[]>(() => canvas.layers())
  /** Rows the user collapsed; everything else is open. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => setLayers(canvas.layers()), [revision, selected])

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
            tabIndex={layer.locator === selected ? 0 : -1}
            className={cn(
              'group flex h-7 cursor-default items-center gap-1 rounded-md pr-2 text-xs select-none',
              layer.locator === selected
                ? 'bg-primary/10 text-foreground'
                : layer.locator === hovered
                  ? 'bg-accent/60'
                  : 'hover:bg-accent/60',
            )}
            style={{ paddingLeft: 4 + depth * 12 }}
            onClick={() => designer.getState().select(layer.locator)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
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
      <ul role="tree" aria-label="Layers" className="m-0 list-none p-0">
        {rows(layers, 0)}
      </ul>
    </div>
  )
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
