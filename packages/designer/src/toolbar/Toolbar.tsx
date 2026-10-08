import { RefreshCwIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { Brand } from '@/toolbar/Brand'
import { commands } from '@/toolbar/commands'
import { ConnectionStatus } from '@/toolbar/ConnectionStatus'
import { HistoryButtons } from '@/toolbar/HistoryButtons'
import { ModeToggle } from '@/toolbar/ModeToggle'
import { ThemeMenu } from '@/toolbar/ThemeMenu'
import { ZoomControl } from '@/toolbar/ZoomControl'

/** Top bar: identity and connection | canvas mode | history, zoom and global actions. */
export function Toolbar() {
  return (
    <header className="grid h-11 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b bg-background px-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <Brand />
        <Separator orientation="vertical" className="mx-1 data-vertical:h-4" />
        <ConnectionStatus />
      </div>
      <ModeToggle />
      <div className="flex min-w-0 items-center justify-end gap-1">
        <HistoryButtons />
        <Separator orientation="vertical" className="mx-1 data-vertical:h-4" />
        <ZoomControl />
        <Separator orientation="vertical" className="mx-1 data-vertical:h-4" />
        <RefreshButton />
        <ThemeMenu />
      </div>
    </header>
  )
}

function RefreshButton() {
  const busy = useSession((s) => s.busy)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={commands.refresh.label} disabled={busy} onClick={commands.refresh.run}>
          <RefreshCwIcon className={cn(busy && 'animate-spin')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{commands.refresh.label}</TooltipContent>
    </Tooltip>
  )
}
