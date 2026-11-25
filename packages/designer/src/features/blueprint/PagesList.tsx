import type { BlueprintPageSummary, BlueprintSummary } from '@/shared/engine/types'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'

interface PagesListProps {
  summary: BlueprintSummary
  openPath: string | null
  busy?: boolean
  onOpen(path: string): void
  onAdd?(): void
  onInitialize(): void
  onPreview?(page: BlueprintPageSummary): void
  onEject?(page: BlueprintPageSummary): void
  onOpenRoute?(page: BlueprintPageSummary): void
}

export function PagesList({ summary, openPath, busy = false, onOpen, onAdd, onInitialize, onPreview, onEject, onOpenRoute }: PagesListProps) {
  if (!summary.exists) {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground">This project has no blueprint.</p>
        <Button size="sm" disabled={busy} onClick={onInitialize}>Create blueprint</Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold">Blueprint pages</h2>
        {onAdd && <Button size="sm" variant="outline" disabled={busy} data-blueprint-add="" onClick={onAdd}>Add page</Button>}
      </div>
      {summary.pages.length === 0 ? (
        <p className="text-muted-foreground">No pages yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {summary.pages.map((page) => (
            <li key={page.path} className="space-y-1 rounded-md border p-2">
              <div className="flex items-start justify-between gap-2">
                {page.status === 'draft' ? (
                  <Button
                    size="sm" variant="ghost" disabled={busy} aria-label={`Edit ${page.name}`} aria-pressed={openPath === page.path}
                    className="-ml-1 h-auto min-w-0 shrink whitespace-normal px-1 py-0.5 text-left [overflow-wrap:anywhere]"
                    onClick={() => onOpen(page.path)}
                  >
                    {page.name}
                  </Button>
                ) : <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{page.name}</span>}
                <Badge variant={page.status === 'edited' ? 'outline' : 'secondary'}>{page.status}</Badge>
              </div>
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{page.route} · {page.kind}</p>
              <p className="text-xs text-muted-foreground">
                {page.errors} {page.errors === 1 ? 'error' : 'errors'} · {page.warnings} {page.warnings === 1 ? 'warning' : 'warnings'}
              </p>
              {page.status === 'edited' && <p className="text-xs text-muted-foreground">Changed since eject. Open the page to edit it, since the code is now the truth.</p>}
              <div className="flex flex-wrap gap-1">
                {page.status === 'draft' && onPreview && (
                  <Button size="xs" variant="outline" disabled={busy} aria-label={`Preview ${page.name}`} onClick={() => onPreview(page)}>Preview</Button>
                )}
                {page.status !== 'draft' && onOpenRoute && (
                  <Button size="xs" variant="outline" disabled={busy} aria-label={`Open ${page.name}`} onClick={() => onOpenRoute(page)}>Open</Button>
                )}
                {page.status !== 'edited' && onEject && (
                  <Button
                    size="xs" variant="outline" disabled={busy}
                    aria-label={`Eject ${page.name}${page.status === 'ejected' ? ' again' : ''}`} onClick={() => onEject(page)}
                  >
                    {page.status === 'ejected' ? 'Eject again' : 'Eject'}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
