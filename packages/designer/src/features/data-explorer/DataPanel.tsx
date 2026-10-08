// The Data tab: the page on the canvas when it is a Refine page (ThisPage: columns or fields), then the
// project's API as contract-sync described it (trivia.manifest.json, through GET /manifest). Each resource lists its operations and fields, and offers a table bound to its
// list query and a create form. Click to insert into the selection, or drag onto the canvas;
// either is one undo entry. A badge says when the spec changed since the code was generated.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRightIcon, FilePlusIcon, FileWarningIcon, FormInputIcon, RefreshCwIcon, TableIcon } from 'lucide-react'
import { toast } from 'sonner'

import { engine } from '@/shared/engine/client'
import type { ManifestResource, ManifestState, PageKind, ResourcePages } from '@/shared/engine/types'
import { dispatchBatch } from '@/shared/state/actions'
import { endTemplateDrag, insertIntoSelection, startTemplateDrag } from '@/shared/insert'
import { cn } from '@/shared/lib/utils'
import { useDesigner } from '@/shared/state/store'
import type { Template } from '@/shared/template'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'

import { type CodegenContext, formTemplate, tableTemplate } from './codegen'
import { DriftList } from './DriftList'
import { ThisPage } from './ThisPage'

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; state: ManifestState }

const parent = (p: string) => p.replace(/\/[^/]+\/?$/, '')

export function DataPanel() {
  const health = useDesigner((s) => s.health)
  const components = useDesigner((s) => s.componentsByName)
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  /** Bumped on every reload, so the drift list re-reads with the manifest. */
  const [reload, setReload] = useState(0)
  const [syncing, setSyncing] = useState(false)
  /** In a Refine app: each contract resource's pages (null: not a Refine app, or unknown). */
  const [refine, setRefine] = useState<Map<string, ResourcePages> | null>(null)
  const revision = useDesigner((s) => s.revision)
  useEffect(() => {
    let live = true
    engine
      .refineResources()
      .then((list) => live && setRefine(list.some((r) => r.existing.length > 0) ? new Map(list.map((r) => [r.resource, r])) : null))
      .catch(() => live && setRefine(null))
    return () => {
      live = false
    }
  }, [revision, reload])

  const refresh = useCallback(async () => {
    setReload((n) => n + 1)
    setLoad({ status: 'loading' })
    try {
      setLoad({ status: 'ready', state: await engine.manifest() })
    } catch (error) {
      setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])
  useEffect(() => void refresh(), [refresh])

  // Regenerate the client and manifest from the spec (POST /sync): refused, with the reason,
  // when the generated code has uncommitted changes.
  const sync = useCallback(async () => {
    setSyncing(true)
    try {
      const result = await engine.sync()
      toast.success(result.contractChanged ? `Synced ${result.files} files from the spec.` : 'The spec is unchanged since the last sync.')
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSyncing(false)
    }
  }, [refresh])

  const ctx = useMemo<CodegenContext | null>(() => {
    if (load.status !== 'ready' || load.state.manifest === null || health === null) return null
    return { manifest: load.state.manifest, components, componentsDir: parent(health.uiDir), componentsImport: parent(health.importBase) }
  }, [load, components, health])

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3">
        <Source load={load} onSync={() => void sync()} syncing={syncing} />
        <Button variant="ghost" size="icon-sm" aria-label="Reload the manifest" onClick={() => void refresh()}>
          <RefreshCwIcon className={cn(load.status === 'loading' && 'animate-spin')} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-width:thin]">
        <DriftList reload={reload} />
        <ThisPage />
        {load.status === 'error' && <p className="px-1 text-xs text-destructive">Couldn’t read the manifest: {load.message}</p>}
        {load.status === 'ready' && load.state.manifest === null && (
          <div className="grid gap-2 px-1 text-xs text-muted-foreground">
            <p>This project has no trivia.manifest.json yet.</p>
            <p>
              Generate one from an OpenAPI spec:{' '}
              <code className="rounded bg-muted px-1 font-mono text-[11px]">trivia-contract-sync --input openapi.json --zod</code>
            </p>
          </div>
        )}
        {ctx && (
          <ul className="grid gap-2" aria-label="Resources">
            {ctx.manifest.resources.map((resource) => (
              <ResourceRow key={resource.name} resource={resource} ctx={ctx} pages={refine?.get(resource.name) ?? null} refine={refine !== null} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Source({ load, onSync, syncing }: { load: Load; onSync: () => void; syncing: boolean }) {
  if (load.status !== 'ready' || load.state.manifest === null) return <span className="text-xs text-muted-foreground">Data</span>
  const { manifest, drift } = load.state
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-xs" title={manifest.source.location}>
        {manifest.source.title ?? manifest.source.location}
      </span>
      {drift?.status === 'changed' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400">
              <FileWarningIcon /> Spec changed
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            {drift.source} changed since the code was generated. Sync to regenerate the client and the manifest from it.
          </TooltipContent>
        </Tooltip>
      )}
      {drift?.status === 'changed' && (
        <Button variant="outline" size="xs" disabled={syncing} onClick={onSync}>
          <RefreshCwIcon className={cn(syncing && 'animate-spin')} />
          Sync
        </Button>
      )}
    </div>
  )
}

const KINDS = ['list', 'get', 'create', 'update', 'delete'] as const

const KIND_LABEL: Record<PageKind, string> = { list: 'List', create: 'Create', edit: 'Edit', show: 'Show' }

function ResourceRow({
  resource,
  ctx,
  pages,
  refine,
}: {
  resource: ManifestResource
  ctx: CodegenContext
  /** Its Refine pages, in a Refine app. */
  pages: ResourcePages | null
  refine: boolean
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const missing = pages ? pages.possible.filter((k) => !pages.existing.includes(k)) : []
  const addPages = async () => {
    setBusy(true)
    try {
      const plan = await engine.planPages(resource.name)
      await dispatchBatch(plan.ops, plan.label)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const table = useMemo(() => tableTemplate(resource, ctx), [resource, ctx])
  const form = useMemo(() => formTemplate(resource, ctx), [resource, ctx])
  const fields = resource.entity?.fields ?? []
  return (
    <li className="rounded-md border bg-background/60 px-2 py-1.5" aria-label={resource.name}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-medium"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRightIcon className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className="truncate">{resource.name}</span>
        </button>
      </div>
      <div className="mt-1 flex flex-wrap gap-0.5 pl-4">
        {KINDS.filter((k) => resource.operations[k] !== null).map((k) => (
          <span key={k} className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
            {k}
          </span>
        ))}
        {resource.customOperations.length > 0 && (
          <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">+{resource.customOperations.length} custom</span>
        )}
      </div>
      {open && fields.length > 0 && (
        <ul className="mt-1 grid gap-0.5 pl-4" aria-label={`${resource.name} fields`}>
          {fields.map((f) => (
            <li key={f.name} className="flex min-w-0 justify-between gap-2 font-mono text-[11px]">
              <span className="truncate">
                {f.name}
                {f.required && <span className="text-destructive">*</span>}
              </span>
              <span className="text-muted-foreground">{f.enum ? 'enum' : f.format ?? f.type}</span>
            </li>
          ))}
        </ul>
      )}
      {refine ? (
        // A Refine app: data goes through Refine's hooks, so Trivia writes Refine pages.
        <div className="mt-1.5 grid gap-1 pl-4">
          <div className="flex flex-wrap gap-0.5" aria-label={`${resource.name} pages`}>
            {(pages?.possible ?? []).map((k) => (
              <span
                key={k}
                className={cn(
                  'rounded px-1 text-[10px]',
                  pages?.existing.includes(k) ? 'bg-primary/10 text-foreground' : 'border border-dashed text-muted-foreground',
                )}
                title={pages?.existing.includes(k) ? `It has a ${k} page` : `No ${k} page yet`}
              >
                {KIND_LABEL[k]}
              </span>
            ))}
          </div>
          {missing.length > 0 && (
            <Button variant="outline" size="xs" className="justify-self-start" disabled={busy} onClick={() => void addPages()}>
              <FilePlusIcon />
              Add {missing.map((k) => KIND_LABEL[k].toLowerCase()).join(', ')} {missing.length === 1 ? 'page' : 'pages'}
            </Button>
          )}
        </div>
      ) : (
        <div className="mt-1.5 flex gap-1">
          <Action icon={<TableIcon />} label="Table" template={table} />
          <Action icon={<FormInputIcon />} label="Create form" template={form} />
        </div>
      )}
    </li>
  )
}

/** A template to click into the selection or drag onto the canvas, or why it isn't available. */
function Action({ icon, label, template }: { icon: React.ReactNode; label: string; template: Template | string }) {
  if (typeof template === 'string') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0}>
            <Button variant="outline" size="xs" disabled className="pointer-events-none">
              {icon}
              {label}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>No {label.toLowerCase()}: {template}.</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Button
      variant="outline"
      size="xs"
      draggable
      title={`Insert a ${template.label.toLowerCase()} into the selection, or drag it onto the canvas`}
      data-data-template={template.label}
      onClick={() => void insertIntoSelection(template)}
      onDragStart={(e) => startTemplateDrag(e.nativeEvent, template)}
      onDragEnd={() => endTemplateDrag()}
    >
      {icon}
      {label}
    </Button>
  )
}
