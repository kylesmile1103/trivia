// Contract drift (docs/product.md, slice 3): the Refine pages that no longer match the contract,
// each issue with its fix (GET /refine/drift). A fix is a column or field plan, applied as one
// undo entry. Re-read after every re-render and whenever the manifest is reloaded.

import { useEffect, useState } from 'react'
import { TriangleAlertIcon, WrenchIcon } from 'lucide-react'
import { toast } from 'sonner'

import { engine } from '@/shared/engine/client'
import type { ColumnChange, ContractDrift, DriftIssue, FieldChange, PageDrift } from '@/shared/engine/types'
import { dispatchBatch } from '@/shared/state/actions'
import { useDesigner } from '@/shared/state/store'
import { Button } from '@/shared/ui/button'

export function DriftList({ reload }: { reload: number }) {
  const revision = useDesigner((s) => s.revision)
  const [drift, setDrift] = useState<ContractDrift | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    engine
      .contractDrift()
      .then((d) => live && setDrift(d))
      .catch(() => live && setDrift(null))
    return () => {
      live = false
    }
  }, [revision, reload])

  const apply = async (page: PageDrift, issue: DriftIssue) => {
    if (!issue.fix) return
    const id = `${page.file}#${page.component}#${issue.name}`
    setBusy(id)
    try {
      const plan =
        page.kind === 'list'
          ? await engine.planColumns(page.file, page.component, issue.fix.changes as ColumnChange[])
          : await engine.planFields(page.file, page.component, issue.fix.changes as FieldChange[])
      await dispatchBatch(plan.ops, issue.fix.label)
      for (const warning of plan.warnings ?? []) toast.warning(warning)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const count = drift?.pages.reduce((n, p) => n + p.issues.length, 0) ?? 0
  if (count === 0) return null
  return (
    <section className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5" aria-label="Out of step with the contract">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">
        <TriangleAlertIcon className="size-3.5" />
        Out of step with the contract ({count})
      </h3>
      <ul className="mt-1 grid gap-1.5">
        {drift!.pages.map((page) => (
          <li key={`${page.file}#${page.component}`}>
            <p className="truncate font-mono text-[10px] text-muted-foreground" title={page.file}>
              {page.component} · {page.file}
            </p>
            <ul className="grid gap-1" aria-label={`Drift in ${page.component}`}>
              {page.issues.map((issue) => {
                const id = `${page.file}#${page.component}#${issue.name}`
                return (
                  <li key={`${issue.code}-${issue.name}`} className="grid gap-0.5 text-xs" aria-label={issue.message}>
                    <span className="leading-snug">
                      {issue.message}
                      {issue.line !== null && <span className="text-muted-foreground"> (line {issue.line})</span>}
                    </span>
                    {issue.references && issue.references.length > 0 && (
                      <ul className="grid gap-0.5" aria-label={`Other code that names ${issue.name}`}>
                        {issue.references.map((r) => (
                          <li key={r.line} className="truncate font-mono text-[10px] text-muted-foreground" title={r.text}>
                            {r.line}: {r.text}
                          </li>
                        ))}
                      </ul>
                    )}
                    {issue.fix && (
                      <Button
                        variant="outline"
                        size="xs"
                        className="justify-self-start"
                        disabled={busy !== null}
                        aria-busy={busy === id}
                        onClick={() => void apply(page, issue)}
                      >
                        <WrenchIcon />
                        {issue.fix.label}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}
