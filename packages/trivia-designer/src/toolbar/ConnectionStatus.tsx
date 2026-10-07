import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { displayHost, proxyTarget } from '@/lib/env'
import { refresh, useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { useDesigner } from '@/state/store'

/** The app the designer is connected to; red with a reconnect action when the link drops. */
export function ConnectionStatus() {
  const health = useDesigner((s) => s.health)
  const lost = useSession((s) => s.lost)
  const failure = useSession((s) => s.failure)
  const busy = useSession((s) => s.busy)
  const host = proxyTarget === null ? window.location.host : displayHost(proxyTarget)
  const project = health?.root.split(/[\\/]/).filter(Boolean).pop()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 gap-2 px-2 font-normal text-muted-foreground"
          disabled={busy}
          onClick={() => void refresh()}
          aria-label={lost ? `Disconnected from ${host}. Reconnect` : `Connected to ${host}. Reload`}
        >
          <span
            aria-hidden="true"
            className={cn('size-1.5 shrink-0 rounded-full', lost ? 'bg-destructive' : 'bg-emerald-500')}
          />
          <span className="truncate font-mono text-xs text-foreground">{host}</span>
          {lost ? (
            <span className="text-xs text-destructive">Disconnected</span>
          ) : (
            project && <span className="hidden truncate text-xs lg:inline">{project}</span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-md">
        {lost ? (
          <div className="grid gap-1">
            <p className="font-medium">Can't reach the engine</p>
            <p className="opacity-80">{failure?.message ?? 'The last check failed.'}</p>
            <p className="opacity-80">Retrying automatically. Click to retry now.</p>
          </div>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt className="opacity-70">App</dt>
            <dd className="font-mono">{proxyTarget ?? window.location.origin}</dd>
            {health && (
              <>
                <dt className="opacity-70">Project</dt>
                <dd className="font-mono break-all">{health.root}</dd>
                <dt className="opacity-70">Components</dt>
                <dd className="font-mono">{health.uiDir}</dd>
                <dt className="opacity-70">Imports</dt>
                <dd className="font-mono">{health.importBase}</dd>
                <dt className="opacity-70">Engine</dt>
                <dd className="font-mono">v{health.version}</dd>
              </>
            )}
          </dl>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
