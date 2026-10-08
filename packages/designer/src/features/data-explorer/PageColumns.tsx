// The page on the canvas, when it is a Refine list page (docs/product.md, slice 1): its columns
// as the source has them, in order, and the contract fields it doesn't show yet. Add a field as
// a column (written by its type: a badge and a multi-select filter for an enum, a date range
// filter for a date…), move a column, or remove one. The plugin plans each change as value ops
// (POST /refine/columns/plan), dispatched as one undo entry like any other edit.

import { useEffect, useState } from 'react'
import { ArrowDownIcon, ArrowUpIcon, Columns3Icon, PlusIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'

import { canvas, type Layer } from '@/shared/canvas'
import { engine } from '@/shared/engine/client'
import type { ColumnChange, FieldShape, ListPage } from '@/shared/engine/types'
import { dispatchBatch } from '@/shared/state/actions'
import { useDesigner } from '@/shared/state/store'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/shared/ui/dropdown-menu'

const SHAPE: Record<FieldShape, string> = {
  text: 'text',
  enum: 'enum',
  number: 'number',
  date: 'date',
  dateTime: 'date-time',
  boolean: 'yes/no',
  list: 'list',
  other: 'object',
}

/** The files the canvas renders elements from (their locators' file part). */
function canvasFiles(layers: Layer[], into = new Set<string>()): Set<string> {
  for (const layer of layers) {
    const last = layer.locator.lastIndexOf('#')
    const mid = last > 0 ? layer.locator.lastIndexOf('#', last - 1) : -1
    if (mid > 0) into.add(layer.locator.slice(0, mid))
    canvasFiles(layer.children, into)
  }
  return into
}

export function PageColumns() {
  const revision = useDesigner((s) => s.revision)
  const [pages, setPages] = useState<ListPage[]>([])

  // Re-read after every re-render: an edit (here, in the IDE, by an agent) or a navigation.
  useEffect(() => {
    let live = true
    const files = canvasFiles(canvas.layers())
    engine
      .refinePages()
      .then((all) => live && setPages(all.filter((p) => files.has(p.file))))
      .catch(() => live && setPages([]))
    return () => {
      live = false
    }
  }, [revision])

  if (pages.length === 0) return null
  return (
    <section className="mb-3 grid gap-2" aria-label="This page">
      {pages.map((page) => (
        <PageCard key={`${page.file}#${page.component}`} page={page} />
      ))}
    </section>
  )
}

function PageCard({ page }: { page: ListPage }) {
  const [busy, setBusy] = useState(false)
  const change = async (changes: ColumnChange[]) => {
    setBusy(true)
    try {
      const plan = await engine.planColumns(page.file, page.component, changes)
      await dispatchBatch(plan.ops, plan.label)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const count = page.columns.length
  return (
    <div className="rounded-md border bg-background/60 px-2 py-1.5" aria-busy={busy}>
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Columns3Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{page.component}</span>
        {page.contract && (
          <Badge variant="secondary" className="ml-auto h-4 px-1 text-[10px]" title={`Columns come from the contract resource ${page.contract.resource}`}>
            {page.contract.resource}
          </Badge>
        )}
      </div>
      <p className="truncate pl-5 font-mono text-[10px] text-muted-foreground" title={page.file}>
        {page.file}
      </p>
      <ul className="mt-1.5 grid gap-0.5" aria-label={`Columns of ${page.component}`}>
        {page.columns.map((column, i) => {
          const name = column.label ?? column.key ?? `Column ${i + 1}`
          const key = column.key ?? column.accessorKey
          return (
            <li key={column.path} className="group flex h-6 items-center gap-1 rounded px-1 text-xs hover:bg-muted" aria-label={name}>
              <span className="min-w-0 flex-1 truncate" title={key ?? undefined}>
                {name}
              </span>
              {column.field && <span className="text-[10px] text-muted-foreground">{SHAPE[column.field.shape]}</span>}
              {key !== null && (
                <span className="flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${name} up`}
                    disabled={busy || i === 0}
                    onClick={() => void change([{ action: 'move', column: key, index: i - 1 }])}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${name} down`}
                    disabled={busy || i === count - 1}
                    onClick={() => void change([{ action: 'move', column: key, index: i + 1 }])}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove column ${name}`}
                    disabled={busy}
                    onClick={() => void change([{ action: 'remove', column: key }])}
                  >
                    <XIcon />
                  </Button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="xs" className="mt-1.5" disabled={busy || page.available.length === 0}>
            <PlusIcon />
            Add column
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 w-52 overflow-y-auto">
          {page.available.map((field) => (
            <DropdownMenuItem key={field.name} onSelect={() => void change([{ action: 'add', field: field.name }])}>
              <span className="flex-1 truncate font-mono text-xs">{field.name}</span>
              <span className="text-[10px] text-muted-foreground">{SHAPE[field.shape]}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {!page.contract && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          No contract resource matches this page: run trivia-contract-sync, or set refineCoreProps.resource.
        </p>
      )}
    </div>
  )
}
