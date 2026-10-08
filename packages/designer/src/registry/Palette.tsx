// The component palette: the user's own components (store.components, from the engine's
// prop analyzer), one row per component module with its parts nested, grouped and
// searchable. Rows drag onto the canvas or, on click/Enter, insert into the selection.

import { ChevronRightIcon, SearchIcon, XIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { loadComponents, useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { type Family, type PaletteItem, buildCatalog, countComponents, filterCatalog } from '@/registry/catalog'
import { iconFor } from '@/registry/icons'
import { endTemplateDrag, insertIntoSelection, placementFor, startTemplateDrag } from '@/registry/insert'
import { PALETTE_SEARCH_ID } from '@/registry/search'
import { useDesigner } from '@/state/store'

export function Palette() {
  const components = useDesigner((s) => s.components)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

  const catalog = useMemo(() => buildCatalog(components), [components])
  const { groups, expanded } = useMemo(() => filterCatalog(catalog, query), [catalog, query])
  const total = useMemo(() => countComponents(catalog), [catalog])

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  return (
    <aside aria-label="Components" className="flex w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-9 shrink-0 items-center justify-between px-3">
        <h2 className="text-xs font-medium">Components</h2>
        {total > 0 && <span className="text-xs text-muted-foreground tabular-nums">{total}</span>}
      </div>
      <div className="shrink-0 px-2 pb-2">
        <SearchField value={query} onChange={setQuery} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-width:thin]" onKeyDown={onListKeyDown}>
        <PaletteBody
          query={query}
          empty={catalog.length === 0}
          groups={groups.map((group) => (
            <section key={group.id} aria-labelledby={`palette-group-${group.id}`} className="pt-2 first:pt-0">
              <h3 id={`palette-group-${group.id}`} className="px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">
                {group.label}
              </h3>
              <ul>
                {group.families.map((family) => (
                  <FamilyRow
                    key={family.key}
                    family={family}
                    // A search that matched only parts holds the family open.
                    open={expanded.has(family.key) || open.has(family.key)}
                    onToggle={expanded.has(family.key) ? undefined : () => toggle(family.key)}
                  />
                ))}
              </ul>
            </section>
          ))}
        />
      </div>
      <SelectionHint />
    </aside>
  )
}

function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={PALETTE_SEARCH_ID}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            if (value) onChange('')
            else e.currentTarget.blur()
          } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
            // Into the results: Enter goes straight to the first match.
            const first = document.querySelector<HTMLElement>('[data-palette-item]')
            if (first) {
              e.preventDefault()
              if (e.key === 'Enter') first.click()
              else first.focus()
            }
          }
        }}
        placeholder="Search components"
        aria-label="Search components"
        autoComplete="off"
        spellCheck={false}
        className="h-7 bg-background pr-7 pl-7 text-xs md:text-xs [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute top-1/2 right-1.5 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      ) : (
        <Kbd className="absolute top-1/2 right-1.5 h-4 min-w-4 -translate-y-1/2 text-[10px]">/</Kbd>
      )}
    </div>
  )
}

/** Loading, error and empty states around the grouped list. */
function PaletteBody({ query, empty, groups }: { query: string; empty: boolean; groups: React.ReactNode[] }) {
  const loaded = useSession((s) => s.componentsLoaded)
  const error = useSession((s) => s.componentsError)
  const uiDir = useDesigner((s) => s.health?.uiDir)

  if (error !== null) {
    return (
      <Notice title="Couldn't load components" action={<RetryButton />}>
        <span className="break-words">{error}</span>
      </Notice>
    )
  }
  if (!loaded) {
    return (
      <div className="grid gap-1 px-2 pt-2" aria-busy="true" aria-label="Loading components">
        {[64, 48, 72, 56, 40, 60].map((w, i) => (
          <div key={i} className="flex h-7 items-center gap-2">
            <div className="size-4 animate-pulse rounded bg-muted" />
            <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    )
  }
  if (empty) {
    return (
      <Notice title="No components found" action={<RetryButton label="Reload" />}>
        Nothing exported from <code className="font-mono">{uiDir ?? 'src/components/ui'}</code>. Add some with{' '}
        <code className="font-mono">npx shadcn add button</code>, then reload.
      </Notice>
    )
  }
  if (groups.length === 0) {
    return <p className="px-2 pt-4 text-center text-xs text-muted-foreground">No components match “{query.trim()}”.</p>
  }
  return <>{groups}</>
}

function Notice({ title, action, children }: { title: string; action: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-1 mt-2 grid gap-2 rounded-lg border border-dashed p-3 text-xs">
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground">{children}</p>
      <div>{action}</div>
    </div>
  )
}

function RetryButton({ label = 'Retry' }: { label?: string }) {
  return (
    <Button variant="outline" size="xs" onClick={() => void loadComponents({ manual: true })}>
      {label}
    </Button>
  )
}

function FamilyRow({ family, open, onToggle }: { family: Family; open: boolean; onToggle: (() => void) | undefined }) {
  const hasParts = family.parts.length > 0
  return (
    <li>
      <div className="flex items-center">
        {hasParts ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`${open ? 'Hide' : 'Show'} ${family.parts.length} parts of ${family.primary.schema.name}`}
            aria-expanded={open}
            disabled={onToggle === undefined}
            onClick={onToggle}
            className="flex h-7 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronRightIcon className={cn('size-3 transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <ItemRow
          item={family.primary}
          icon={iconFor(family.primary.schema.name)}
          meta={family.size > 1 ? String(family.size) : undefined}
          onExpand={hasParts && !open ? onToggle : undefined}
          onCollapse={hasParts && open ? onToggle : undefined}
        />
      </div>
      {hasParts && open && (
        <ul className="mb-1 ml-[1.375rem] border-l pl-1" aria-label={`${family.primary.schema.name} parts`}>
          {family.parts.map((part) => (
            <li key={part.schema.name}>
              <ItemRow item={part} compact />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** One draggable, clickable component. A div, not a <button>: Firefox won't drag buttons. */
function ItemRow(props: {
  item: PaletteItem
  icon?: React.ReactNode
  meta?: string
  compact?: boolean
  onExpand?: () => void
  onCollapse?: () => void
}) {
  const { item, icon, meta, compact, onExpand, onCollapse } = props
  const { template } = item
  const imports = [...new Set(template.imports.map((i) => i.source))]
  return (
    <Tooltip delayDuration={600}>
      <TooltipTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          draggable
          data-palette-item={template.component}
          aria-label={template.label}
          onClick={() => void insertIntoSelection(template)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              void insertIntoSelection(template)
            } else if (e.key === 'ArrowRight' && onExpand) {
              e.preventDefault()
              onExpand()
            } else if (e.key === 'ArrowLeft' && onCollapse) {
              e.preventDefault()
              onCollapse()
            }
          }}
          onDragStart={(e) => startTemplateDrag(e.nativeEvent, template)}
          onDragEnd={endTemplateDrag}
          className={cn(
            'flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-md px-1.5 text-xs outline-none select-none',
            'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50',
            'active:cursor-grabbing',
            compact ? 'h-6 text-muted-foreground hover:text-sidebar-accent-foreground' : 'h-7',
          )}
        >
          {icon && <span className="flex shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span>}
          <span className="truncate">{template.label}</span>
          {meta && <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{meta}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" sideOffset={8} className="max-w-md flex-col items-start gap-1.5 py-2">
        <pre className="font-mono text-[11px] leading-4 whitespace-pre">{template.snippet}</pre>
        <span className="text-[11px] opacity-70">from {imports.join(', ')}</span>
      </TooltipContent>
    </Tooltip>
  )
}

/** Arrow keys move between rows (search field ⇄ rows, top to bottom). */
function onListKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-palette-item]')]
  const index = rows.indexOf(document.activeElement as HTMLElement)
  if (index === -1) return
  e.preventDefault()
  const next = e.key === 'ArrowDown' ? rows[index + 1] : rows[index - 1]
  if (next) next.focus()
  else if (e.key === 'ArrowUp') document.getElementById(PALETTE_SEARCH_ID)?.focus()
}

/** What a click does right now: the hint follows the canvas selection. */
function SelectionHint() {
  const selected = useDesigner((s) => s.selected)
  const details = useDesigner((s) => (s.details !== null && s.details.locator === s.selected ? s.details : null))
  const acceptsChildren = useDesigner((s) => (details ? s.componentsByName[details.name]?.acceptsChildren : undefined))
  let text: React.ReactNode
  if (selected === null) {
    text = 'Drag onto the canvas, or select an element and click to insert into it.'
  } else if (details === null) {
    text = 'Click to insert into the selection, or drag onto the canvas.'
  } else {
    const where = placementFor(details, acceptsChildren) === 'after' ? 'after' : 'into'
    text = (
      <>
        Click to insert {where} <span className="font-mono text-foreground">{`<${details.name}>`}</span>, or drag onto
        the canvas.
      </>
    )
  }
  return <p className="shrink-0 border-t px-3 py-2 text-[11px] leading-4 text-muted-foreground">{text}</p>
}
