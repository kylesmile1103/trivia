import { useId, useState } from 'react'

import type { BlueprintDiagnostic } from '@/shared/engine/types'
import { Button } from '@/shared/ui/button'
import { Label } from '@/shared/ui/label'

export function ExpressionInput({ label, pointer, value, onSave, diagnostics = [], proposed = false }: {
  label: string
  pointer: string
  value: string
  diagnostics?: BlueprintDiagnostic[]
  proposed?: boolean
  onSave(value: string): void
}) {
  const id = useId()
  const [edit, setEdit] = useState<{ base: string; text: string } | null>(null)
  const text = edit?.base === value ? edit.text : value
  const findings = text === value ? diagnostics : []
  const invalid = findings.some(({ severity }) => severity === 'error')
  const canSave = text.trim() !== '' && (proposed || text !== value)

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id} data-pointer={pointer} value={text} rows={2} spellCheck={false} autoComplete="off"
        aria-invalid={invalid || undefined}
        aria-describedby={findings.length ? findings.map((_, index) => id + '-' + index).join(' ') : undefined}
        className="min-w-0 rounded-md border border-input bg-background p-2 font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
        onChange={(event) => setEdit({ base: value, text: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            if (canSave) onSave(text)
          }
          if (event.key === 'Escape' && text !== value) {
            event.preventDefault()
            event.stopPropagation()
            setEdit(null)
          }
        }}
      />
      {findings.map(({ span, message, severity }, index) => {
        const start = span ? Math.min(text.length, Math.max(0, span.start)) : 0
        const end = span ? Math.min(text.length, Math.max(start, span.end)) : 0
        return (
          <div key={index} className="space-y-1 text-xs">
            {span?.unit === 'utf16' && (
              <code aria-hidden="true" className="block whitespace-pre-wrap rounded-sm bg-muted p-1 [overflow-wrap:anywhere]">
                {text.slice(0, start)}
                <u className="decoration-wavy decoration-destructive underline-offset-2">{text.slice(start, end) || '▏'}</u>
                {text.slice(end)}
              </code>
            )}
            <p id={id + '-' + index} role={severity === 'error' ? 'alert' : undefined} className={severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{message}</p>
          </div>
        )
      })}
      <Button type="button" size="xs" variant="outline" disabled={!canSave} onClick={() => onSave(text)}>Save expression</Button>
    </div>
  )
}
