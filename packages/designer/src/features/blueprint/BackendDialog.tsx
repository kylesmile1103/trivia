import { useEffect, useState } from 'react'

import { ApiError } from '@/shared/engine/client'
import type { BlueprintBackendResult } from '@/shared/engine/types'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

import { blueprintApi, problemOf } from './api'
import { DialogFrame } from './DialogFrame'
import { Field } from './fields'

const migrationName = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]*$/u
const isBlocked = (result: BlueprintBackendResult) =>
  result.diagnostics.some(({ severity }) => severity === 'error') || result.files.some(({ action }) => action === 'refused')

function backendProblem(error: unknown) {
  const base = problemOf(error)
  const hint = error instanceof ApiError ? error.details?.hint : undefined
  return { ...base, hint: typeof hint === 'string' ? hint : undefined }
}

function FileTable({ title, result }: { title: string; result: BlueprintBackendResult }) {
  return (
    <div className="space-y-2">
      <table aria-label={title} className="w-full border-collapse text-left text-xs">
        <thead className="border-b text-muted-foreground">
          <tr><th scope="col" className="py-1.5 pr-3">File</th><th scope="col" className="py-1.5">Action</th></tr>
        </thead>
        <tbody>
          {result.files.map(({ path, action }) => (
            <tr key={path} className="border-b">
              <th scope="row" className="py-1.5 pr-3 font-mono font-normal [overflow-wrap:anywhere]">{path}</th>
              <td className={action === 'refused' ? 'py-1.5 text-destructive' : 'py-1.5'}>{action}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.diagnostics.length > 0 && (
        <ul className="space-y-1 text-xs">
          {result.diagnostics.map(({ doc, pointer, message, severity }, index) => (
            <li key={doc + pointer + index} className={severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
              {message}
            </li>
          ))}
        </ul>
      )}
      {result.log && <details className="text-xs">
        <summary className="cursor-pointer">Generator output</summary>
        <pre className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{result.log}</pre>
      </details>}
    </div>
  )
}

export function BackendDialog({ modelRev, appRev, onClose }: { modelRev: string; appRev: string | null; onClose(): void }) {
  const [plan, setPlan] = useState<BlueprintBackendResult | null>(null)
  const [generation, setGeneration] = useState<BlueprintBackendResult | null>(null)
  const [migrationResult, setMigrationResult] = useState<BlueprintBackendResult | null>(null)
  const [problem, setProblem] = useState<ReturnType<typeof backendProblem> | null>(null)
  const [migration, setMigration] = useState('')
  const [writing, setWriting] = useState(false)
  const [basis] = useState(() => ({ modelRev, appRev }))
  const requestedMigration = migration.trim()
  const invalidName = requestedMigration !== '' && !migrationName.test(requestedMigration)
  const complete = generation && !isBlocked(generation)
  const canConfirm = plan && !isBlocked(plan) && !problem && !generation
  const planning = !plan && !problem

  useEffect(() => {
    let active = true
    void blueprintApi.backend({ mode: 'plan' }).then(
      (result) => { if (active) setPlan(result) },
      (error: unknown) => { if (active) setProblem(backendProblem(error)) },
    )
    return () => { active = false }
  }, [])

  async function confirm() {
    if (!canConfirm || writing || invalidName) return
    setWriting(true)
    let generated = false
    try {
      const summary = await blueprintApi.summary()
      if (summary.model?.rev !== basis.modelRev || (summary.app?.rev ?? null) !== basis.appRev) {
        setProblem({ message: 'The blueprint changed. Close this dialog and review a fresh plan.', diagnostics: [], hint: undefined })
        return
      }
      const result = await blueprintApi.backend({ mode: 'write' })
      setGeneration(result)
      generated = !isBlocked(result)
      if (generated && requestedMigration) {
        const migration = await blueprintApi.backend({ mode: 'write', migration: requestedMigration })
        setMigrationResult(migration)
      }
    } catch (error) {
      const failure = backendProblem(error)
      setProblem(generated ? { ...failure, message: 'Backend generation completed. The migration failed. ' + failure.message } : failure)
    } finally {
      setWriting(false)
    }
  }

  return (
    <DialogFrame title="Generate backend" description="Review the file plan from trivia-dotnet before generating the API." busy={writing} onClose={onClose}>
      {planning && <p role="status">Planning backend…</p>}
      {problem && (
        <div role="alert" className="space-y-1 text-xs text-destructive">
          <p>{problem.message}</p>
          {problem.hint && <p>{problem.hint}</p>}
          {problem.diagnostics.map((item, index) => <p key={index}>{item.message}</p>)}
        </div>
      )}
      {generation ? <FileTable title="Backend generation result" result={generation} /> : plan && <FileTable title="Backend file plan" result={plan} />}
      {migrationResult && <FileTable title="Migration result" result={migrationResult} />}
      {canConfirm && <Field label="Migration name (optional)">{(id) => (
        <>
          <Input id={id} value={migration} spellCheck={false} disabled={writing} aria-invalid={invalidName || undefined}
            aria-describedby={invalidName ? id + '-error' : undefined} onChange={(event) => setMigration(event.target.value)} />
          {invalidName && <p id={id + '-error'} className="text-xs text-destructive">Enter a valid C# identifier.</p>}
        </>
      )}</Field>}
      {writing && <p role="status">Generating backend…</p>}
      {complete && !writing && (
        <div className="space-y-1 text-xs">
          <h3 className="font-semibold">Next steps</h3>
          <ol className="list-inside list-decimal space-y-1">
            <li>Build the generated solution and start the API.</li>
            <li>Sync the API’s OpenAPI contract from the Data tab.</li>
            <li>Review contract drift in the Data tab.</li>
          </ol>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Backend writes are outside undo history.</p>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" disabled={writing} onClick={onClose}>{canConfirm ? 'Cancel' : 'Close'}</Button>
        {canConfirm && (
          <Button type="button" size="sm" data-confirm="" disabled={writing || invalidName} onClick={() => void confirm()}>
            Confirm generation
          </Button>
        )}
      </div>
    </DialogFrame>
  )
}
