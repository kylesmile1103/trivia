import { MousePointer2Icon, PointerIcon } from 'lucide-react'

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type DesignerState, useDesigner } from '@/state/store'

type Mode = DesignerState['mode']

const MODES: ReadonlyArray<{ value: Mode; label: string; hint: string; icon: React.ReactNode }> = [
  { value: 'design', label: 'Design', hint: 'Select, drag and edit elements', icon: <MousePointer2Icon /> },
  { value: 'interact', label: 'Interact', hint: 'Use the app: clicks and typing go to it', icon: <PointerIcon /> },
]

export function ModeToggle() {
  const mode = useDesigner((s) => s.mode)
  const setMode = useDesigner((s) => s.setMode)
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      value={mode}
      // Radix reports "" when the active item is clicked again; a mode is always active.
      onValueChange={(value) => value && setMode(value as Mode)}
      aria-label="Canvas mode"
    >
      {MODES.map((m) => (
        <Tooltip key={m.value}>
          <TooltipTrigger asChild>
            <ToggleGroupItem
              value={m.value}
              aria-label={m.label}
              // The tooltip trigger takes over data-state, so the active look keys off aria-checked.
              className="gap-1.5 px-2.5 text-xs text-muted-foreground aria-checked:bg-muted aria-checked:text-foreground"
            >
              {m.icon}
              {m.label}
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent side="bottom">{m.hint}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  )
}
