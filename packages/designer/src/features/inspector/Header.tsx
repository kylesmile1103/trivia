// Inspector header: what is selected (name, file:line, locator) and where it sits (ancestor
// breadcrumb; clicking an ancestor selects it).

import { ChevronRight, CodeXml, Component, Copy, Hash, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { toast } from 'sonner'

import type { NodeDetails } from '@/shared/engine/types'
import { useDesigner } from '@/shared/state/store'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'

import { isIntrinsic, locatorScope } from './model'
import { useAncestors } from './useNodeDetails'

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`Copied ${what}`, { description: text })
  } catch (error) {
    toast.error(`Couldn't copy ${what}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** `flag`, but only once it has stayed true for `ms` — a re-read after a commit takes a few
 *  milliseconds and shouldn't flash a spinner. */
function useLingering(flag: boolean, ms: number): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!flag) return
    const timer = setTimeout(() => setShown(true), ms)
    return () => {
      clearTimeout(timer)
      setShown(false)
    }
  }, [flag, ms])
  return flag && shown
}

export function Header({ details, refreshing }: { details: NodeDetails; refreshing: boolean }) {
  const showSpinner = useLingering(refreshing, 250)
  const position = `${details.file}:${details.line}:${details.column}`
  const Icon = isIntrinsic(details.name) ? CodeXml : Component
  return (
    <header className="space-y-1.5 border-b px-3 pt-2.5 pb-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 truncate font-mono text-[13px] font-semibold">{details.name}</h2>
        {!details.isDirect && (
          <Hint text="Rendered from a {…} expression (e.g. .map()): edits change the source template, so every rendered copy follows. It can't be moved or removed from the canvas.">
            <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">
              in expression
            </Badge>
          </Hint>
        )}
        {details.isRoot && (
          <Hint text={`The root element returned by ${locatorScope(details.locator) ?? 'its component'}.`}>
            <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">
              root
            </Badge>
          </Hint>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {showSpinner && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Refreshing" />}
          <Hint text={`Copy locator · ${details.locator}`}>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Copy locator"
              className="text-muted-foreground"
              onClick={() => void copy(details.locator, 'locator')}
            >
              <Hash />
            </Button>
          </Hint>
        </div>
      </div>
      <Hint text="Copy file:line:column">
        <button
          type="button"
          aria-label={`Copy source position ${position}`}
          className="group flex max-w-full items-center gap-1 rounded-sm font-mono text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => void copy(position, 'source position')}
        >
          <span className="truncate">
            {details.file}:{details.line}
          </span>
          <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </button>
      </Hint>
      <Breadcrumb details={details} />
    </header>
  )
}

function Breadcrumb({ details }: { details: NodeDetails }) {
  const select = useDesigner((s) => s.select)
  const { crumbs, error } = useAncestors(details)
  const scope = locatorScope(details.locator)
  return (
    <nav aria-label="Ancestors">
      <ol className="flex min-w-0 flex-wrap items-center gap-y-0.5 font-mono text-[11px] text-muted-foreground">
        {scope !== null && <li className="pr-0.5 opacity-70">{scope}</li>}
        {crumbs === null ? (
          <li className="flex items-center" aria-label="Loading ancestors">
            <Separator />
            <span className="h-3 w-16 animate-pulse rounded-sm bg-muted" />
          </li>
        ) : (
          crumbs.map((crumb) => (
            <li key={crumb.locator} className="flex items-center">
              <Separator />
              <button
                type="button"
                className="rounded-sm px-1 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => select(crumb.locator)}
              >
                {crumb.name}
              </button>
            </li>
          ))
        )}
        {error !== null && (
          <li className="flex items-center">
            <Separator />
            <Hint text={`Couldn't load every ancestor: ${error}`}>
              <TriangleAlert className="size-3 text-destructive" aria-label="Ancestors incomplete" />
            </Hint>
          </li>
        )}
        <li className="flex items-center" aria-current="location">
          {(scope !== null || (crumbs?.length ?? 0) > 0) && <Separator />}
          <span className="px-1 text-foreground">{details.name}</span>
        </li>
      </ol>
    </nav>
  )
}

function Separator() {
  return <ChevronRight className="size-3 shrink-0 opacity-50" aria-hidden />
}

function Hint({ text, children }: { text: string; children: ReactElement }) {
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
