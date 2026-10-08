import { MinusIcon, PlusIcon } from 'lucide-react'

import { type Command, commands } from '@/shared/commands/commands'
import { formatShortcut } from '@/shared/lib/keyboard'
import { useDesigner } from '@/shared/state/store'
import { ZOOM_MAX, ZOOM_MIN, formatZoom } from '@/shared/state/zoom'
import { Button } from '@/shared/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'
import { Kbd } from '@/shared/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'

/** The zoom menu's direct choices. */
const PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2]

export function ZoomControl() {
  const zoom = useDesigner((s) => s.zoom)
  const setZoom = useDesigner((s) => s.setZoom)
  return (
    <div className="flex items-center" role="group" aria-label="Zoom">
      <ZoomStep command={commands.zoomOut} icon={<MinusIcon />} disabled={zoom <= ZOOM_MIN} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="w-14 px-0 font-mono text-xs tabular-nums" aria-label="Zoom level">
            {formatZoom(zoom)}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-48">
          <MenuCommand command={commands.zoomIn} disabled={zoom >= ZOOM_MAX} />
          <MenuCommand command={commands.zoomOut} disabled={zoom <= ZOOM_MIN} />
          <MenuCommand command={commands.zoomFit} />
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={String(PRESETS.find((p) => Math.abs(p - zoom) < 1e-3) ?? '')}
            onValueChange={(value) => setZoom(Number(value))}
          >
            {PRESETS.map((preset) => (
              <DropdownMenuRadioItem key={preset} value={String(preset)} className="tabular-nums">
                {formatZoom(preset)}
                {preset === 1 && commands.zoomReset.shortcut && (
                  <DropdownMenuShortcut>{formatShortcut(commands.zoomReset.shortcut)}</DropdownMenuShortcut>
                )}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ZoomStep command={commands.zoomIn} icon={<PlusIcon />} disabled={zoom >= ZOOM_MAX} />
    </div>
  )
}

function ZoomStep({ command, icon, disabled }: { command: Command; icon: React.ReactNode; disabled: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={command.label} disabled={disabled} onClick={command.run}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span>{command.label}</span>
        {command.shortcut && <Kbd>{formatShortcut(command.shortcut)}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

function MenuCommand({ command, disabled }: { command: Command; disabled?: boolean }) {
  return (
    <DropdownMenuItem disabled={disabled} onSelect={command.run}>
      {command.label}
      {command.shortcut && <DropdownMenuShortcut>{formatShortcut(command.shortcut)}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  )
}
