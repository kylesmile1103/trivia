// The page on the canvas, when it is a Refine page (docs/product.md): a list page's columns
// (slice 1) or a form page's fields (slice 2), in order, and the contract fields it doesn't have
// yet. Add a field (written by its type), move one, or remove one. The plugin plans each change
// (POST /refine/columns/plan, /refine/fields/plan); it is dispatched as one undo entry like any
// other edit.

import { useEffect, useState } from 'react'
import { ArrowDownIcon, ArrowUpIcon, Columns3Icon, FormInputIcon, PlusIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'

import { canvas, type Layer } from '@/shared/canvas'
import { engine } from '@/shared/engine/client'
import type { ColumnPlan, FieldShape, FormPage, ListPage, PageField, RefinePage } from '@/shared/engine/types'
import { dispatchBatch } from '@/shared/state/actions'
import { useDesigner } from '@/shared/state/store'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/shared/ui/dropdown-menu'

import { boundsText } from './bounds'

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

export function ThisPage() {
  const revision = useDesigner((s) => s.revision)
  const [pages, setPages] = useState<RefinePage[]>([])

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
      {pages.map((page) =>
        page.kind === 'list' ? (
          <ColumnsCard key={`${page.file}#${page.component}`} page={page} />
        ) : (
          <FieldsCard key={`${page.file}#${page.component}`} page={page} />
        ),
      )}
    </section>
  )
}

function ColumnsCard({ page }: { page: ListPage }) {
  return (
    <PageCard
      icon={<Columns3Icon className="size-3.5 shrink-0 text-muted-foreground" />}
      page={page}
      noun="column"
      listLabel={`Columns of ${page.component}`}
      items={page.columns.map((c, i) => ({
        key: c.key ?? c.accessorKey,
        name: c.label || c.key || `Column ${i + 1}`,
        shape: c.field?.shape ?? null,
      }))}
      available={page.available}
      contract={page.contract?.resource ?? null}
      missing="No contract resource matches this page: run trivia-contract-sync, or set refineCoreProps.resource."
      plan={(change) =>
        engine.planColumns(
          page.file,
          page.component,
          change.action === 'add'
            ? [{ action: 'add', field: change.field }]
            : change.action === 'remove'
              ? [{ action: 'remove', column: change.key }]
              : [{ action: 'move', column: change.key, index: change.index }],
        )
      }
    />
  )
}

function FieldsCard({ page }: { page: FormPage }) {
  // Only fields the form renders have a place to move to.
  const rendered = page.fields.filter((f) => f.control !== null)
  return (
    <PageCard
      icon={<FormInputIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      page={page}
      noun="field"
      listLabel={`Fields of ${page.component}`}
      items={rendered.map((f) => ({ key: f.name, name: f.label || f.name, shape: f.field?.shape ?? null }))}
      available={page.available}
      contract={page.contract ? `${page.contract.resource} · ${page.contract.operation}` : null}
      missing="No contract request body matches this form: run trivia-contract-sync, or set refineCoreProps.resource and action."
      plan={(change) =>
        engine.planFields(
          page.file,
          page.component,
          change.action === 'add'
            ? [{ action: 'add', field: change.field }]
            : change.action === 'remove'
              ? [{ action: 'remove', field: change.key }]
              : [{ action: 'move', field: change.key, index: change.index }],
        )
      }
    />
  )
}

type Change = { action: 'add'; field: string } | { action: 'remove'; key: string } | { action: 'move'; key: string; index: number }

interface Item {
  /** What a change names it by; null: it can't be changed from here. */
  key: string | null
  name: string
  shape: FieldShape | null
}

function PageCard({
  icon,
  page,
  noun,
  listLabel,
  items,
  available,
  contract,
  missing,
  plan,
}: {
  icon: React.ReactNode
  page: RefinePage
  noun: string
  listLabel: string
  items: Item[]
  available: PageField[]
  contract: string | null
  missing: string
  plan: (change: Change) => Promise<ColumnPlan>
}) {
  const [busy, setBusy] = useState(false)
  const change = async (c: Change) => {
    setBusy(true)
    try {
      const planned = await plan(c)
      await dispatchBatch(planned.ops, planned.label)
      for (const warning of planned.warnings ?? []) toast.warning(warning)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)
  return (
    <div className="rounded-md border bg-background/60 px-2 py-1.5" aria-busy={busy}>
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {icon}
        <span className="truncate">{page.component}</span>
        {contract && (
          <Badge variant="secondary" className="ml-auto h-4 px-1 text-[10px]" title={`Its ${noun}s come from the contract: ${contract}`}>
            {contract}
          </Badge>
        )}
      </div>
      <p className="truncate pl-5 font-mono text-[10px] text-muted-foreground" title={page.file}>
        {page.file}
      </p>
      <ul className="mt-1.5 grid gap-0.5" aria-label={listLabel}>
        {items.map((item, i) => (
          <li key={item.key ?? `item-${i}`} className="group flex h-6 items-center gap-1 rounded px-1 text-xs hover:bg-muted" aria-label={item.name}>
            <span className="min-w-0 flex-1 truncate" title={item.key ?? undefined}>
              {item.name}
            </span>
            {item.shape && <span className="text-[10px] text-muted-foreground group-focus-within:invisible group-hover:invisible">{SHAPE[item.shape]}</span>}
            {item.key !== null && (
              <span className="flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Move ${item.name} up`}
                  disabled={busy || i === 0}
                  onClick={() => void change({ action: 'move', key: item.key!, index: i - 1 })}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Move ${item.name} down`}
                  disabled={busy || i === items.length - 1}
                  onClick={() => void change({ action: 'move', key: item.key!, index: i + 1 })}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${noun} ${item.name}`}
                  disabled={busy}
                  onClick={() => void change({ action: 'remove', key: item.key! })}
                >
                  <XIcon />
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="xs" className="mt-1.5" disabled={busy || available.length === 0}>
            <PlusIcon />
            Add {noun}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 w-52 overflow-y-auto" aria-label={`${Noun}s to add`}>
          {available.map((field) => (
            <DropdownMenuItem key={field.name} title={boundsText(field.constraints)} onSelect={() => void change({ action: 'add', field: field.name })}>
              <span className="flex-1 truncate font-mono text-xs">
                {field.name}
                {field.required && <span className="text-destructive">*</span>}
              </span>
              <span className="text-[10px] text-muted-foreground">{SHAPE[field.shape]}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {!contract && <p className="mt-1 text-[10px] text-muted-foreground">{missing}</p>}
    </div>
  )
}
