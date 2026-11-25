import { useEffect, useState } from 'react'

import { canvas } from '@/shared/canvas'
import { isValueOp, type BlueprintEjectPlan, type BlueprintPageSummary, type RegistryItem } from '@/shared/engine/types'
import { dispatchBatch, editedFiles } from '@/shared/state/actions'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

import { blueprintApi, problemOf, requirementsOf } from './api'
import { DialogFrame } from './DialogFrame'
import { Field } from './fields'

type PlanState =
  | { kind: 'loading' }
  | { kind: 'ready'; plan: BlueprintEjectPlan }
  | { kind: 'missing'; requires: RegistryItem[] }
  | { kind: 'error'; problem: ReturnType<typeof problemOf> }

function installCommand(requires: RegistryItem[]): string {
  const items = requires.flatMap(({ registry, item }) => {
    if (registry === 'local') return []
    if (registry === 'refine') return ['https://ui.refine.dev/r/' + encodeURIComponent(item) + '.json']
    return [/^[\w@./:+-]+$/.test(item) ? item : "'" + item.replaceAll("'", "'\\''") + "'"]
  })
  return items.length ? 'pnpm dlx shadcn add -- ' + items.join(' ') : ''
}

function MissingComponents({ requires }: { requires: RegistryItem[] }) {
  const [copy, setCopy] = useState('')
  const command = installCommand(requires)
  return (
    <div className="space-y-2">
      <p>Install the required components in the app, then plan the eject again.</p>
      <ul className="list-inside list-disc text-xs">
        {requires.map(({ registry, item }) => (
          <li key={registry + '/' + item}>{item} · {registry === 'local' ? 'add the local component' : registry}</li>
        ))}
      </ul>
      {command && (
        <>
          <Field label="Install command">{(id) => <Input id={id} readOnly value={command} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />}</Field>
          <Button size="sm" variant="outline" onClick={() => {
            void (async () => {
              try { await navigator.clipboard.writeText(command); setCopy('Command copied.') }
              catch { setCopy('Select and copy the install command above.') }
            })()
          }}>Copy command</Button>
          <p role="status" className="text-xs text-muted-foreground">{copy}</p>
        </>
      )}
    </div>
  )
}

function EjectPlanDetails({ plan, route }: { plan: BlueprintEjectPlan; route: string }) {
  const files = [...new Set([...plan.files, ...editedFiles(plan.ops)])]
  const resources = plan.ops.filter(isValueOp).filter((op) => op.path.includes('#<Refine>.resources'))
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-xs font-semibold">Files</h3>
        <ul className="list-inside list-disc space-y-1 text-xs [overflow-wrap:anywhere]">
          {files.map((file) => <li key={file}><code>{file}</code></li>)}
        </ul>
      </div>
      <p className="text-xs [overflow-wrap:anywhere]"><strong>Route</strong> <code>{route}</code></p>
      {resources.length > 0 && (
        <div className="space-y-1 text-xs">
          <h3 className="font-semibold">Refine resource changes</h3>
          <ul className="space-y-1 [overflow-wrap:anywhere]">
            {resources.map((op, index) => (
              <li key={index}><code>{op.path}{'prop' in op ? '.' + op.prop : ''}{'value' in op ? ' = ' + op.value : ''}</code></li>
            ))}
          </ul>
        </div>
      )}
      {plan.warnings.length > 0 && <ul className="list-inside list-disc text-xs text-muted-foreground">{plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    </div>
  )
}

export function EjectDialog({ page, onClose, onRefresh }: {
  page: BlueprintPageSummary
  onClose(): void
  onRefresh(): void
}) {
  const [state, setState] = useState<PlanState>({ kind: 'loading' })
  const [applying, setApplying] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const { name } = page

  useEffect(() => {
    let active = true
    void blueprintApi.plan([name]).then(
      (plan) => {
        if (active) setState(plan.requires.length ? { kind: 'missing', requires: plan.requires } : { kind: 'ready', plan })
      },
      (error: unknown) => {
        if (!active) return
        const requires = requirementsOf(error)
        setState(requires.length ? { kind: 'missing', requires } : { kind: 'error', problem: problemOf(error) })
      },
    )
    return () => { active = false }
  }, [name])

  async function confirm(plan: BlueprintEjectPlan, route: string) {
    setApplying(true)
    const result = await dispatchBatch(plan.ops, plan.label)
    try {
      if (!result) {
        setProblem('The eject was refused. Close this dialog and request a fresh plan.')
        return
      }
      // The transaction already wrote the lock. The endpoint verifies its history entry.
      if (result.changed) await blueprintApi.ejected([name], plan.label)
      canvas.navigate(route)
      onClose()
    } catch (error) {
      setProblem('The source and lock were written, but the history entry could not be verified. ' + problemOf(error).message)
    } finally {
      onRefresh()
      setApplying(false)
    }
  }

  const route = state.kind === 'ready' ? state.plan.lock.pages[name]?.route ?? page.route : page.route
  return (
    <DialogFrame title={`Eject ${name}`} description="Review the planned changes before writing this page to the app." busy={applying} onClose={onClose}>
      {state.kind === 'loading' && <p role="status">Planning eject…</p>}
      {state.kind === 'missing' && <MissingComponents requires={state.requires} />}
      {state.kind === 'error' && (
        <div role="alert" className="space-y-1 text-destructive">
          <p>{state.problem.message}</p>
          {state.problem.diagnostics.map((item, index) => <p key={index}>{item.message}</p>)}
        </div>
      )}
      {state.kind === 'ready' && <EjectPlanDetails plan={state.plan} route={route} />}
      {problem && <p role="alert" className="text-destructive">{problem}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={applying} onClick={onClose}>{state.kind === 'ready' && !problem ? 'Cancel' : 'Close'}</Button>
        {state.kind === 'ready' && !problem && (
          <Button size="sm" data-confirm="" disabled={applying} onClick={() => void confirm(state.plan, route)}>
            {applying ? 'Ejecting…' : 'Confirm eject'}
          </Button>
        )}
      </div>
    </DialogFrame>
  )
}
