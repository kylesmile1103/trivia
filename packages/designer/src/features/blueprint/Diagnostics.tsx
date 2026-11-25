import type { BlueprintDiagnostic } from '@/shared/engine/types'
import { Button } from '@/shared/ui/button'

/** Focus the most specific editable field. Pointers inside arrays or JSON editors can
 * land on their enclosing field when the exact child has no separate input. */
export function focusDiagnosticField(root: HTMLElement, pointer: string): boolean {
  const fields = [...root.querySelectorAll<HTMLElement>('[data-pointer]')]
    .filter((field) => !field.matches(':disabled') && !field.closest('[hidden]'))
    .sort((a, b) => (b.dataset.pointer?.length ?? 0) - (a.dataset.pointer?.length ?? 0))
  const field = fields.find(({ dataset }) => dataset.pointer === pointer || (dataset.pointer && pointer.startsWith(dataset.pointer + '/')))
  field?.focus()
  return field !== undefined
}

export function Diagnostics({ diagnostics, onActivate, showPath = false }: {
  diagnostics: BlueprintDiagnostic[]
  onActivate(diagnostic: BlueprintDiagnostic): void
  showPath?: boolean
}) {
  if (!diagnostics.length) return null
  return (
    <section aria-label="Diagnostics" className="space-y-1 text-xs">
      <h3 className="font-semibold">Diagnostics</h3>
      <ul className="space-y-1">
        {diagnostics.map((diagnostic, index) => (
          <li key={`${diagnostic.doc}:${diagnostic.pointer}:${diagnostic.code}:${index}`}>
            <Button
              type="button" variant="ghost"
              className="grid h-auto w-full justify-items-start gap-0.5 whitespace-normal px-1 py-1 text-left text-xs [overflow-wrap:anywhere]"
              onClick={() => onActivate(diagnostic)}
            >
              <span className={diagnostic.severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}>
                {diagnostic.severity === 'error' ? 'Error' : 'Warning'}{showPath && ` · ${diagnostic.doc}`}
              </span>
              <span>{diagnostic.message}</span>
            </Button>
            {diagnostic.hint?.text && <p className="px-1 text-muted-foreground">{diagnostic.hint.text}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}
