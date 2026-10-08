import { Redo2Icon, Undo2Icon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatShortcut } from '@/lib/keyboard'
import { useDesigner } from '@/state/store'
import { commands } from '@/toolbar/commands'

export function HistoryButtons() {
  const history = useDesigner((s) => s.history)
  return (
    <div className="flex items-center">
      <HistoryButton
        name="Undo"
        icon={<Undo2Icon />}
        enabled={history.canUndo}
        detail={history.undoLabel}
        shortcut={commands.undo.shortcut}
        onClick={commands.undo.run}
      />
      <HistoryButton
        name="Redo"
        icon={<Redo2Icon />}
        enabled={history.canRedo}
        detail={history.redoLabel}
        shortcut={commands.redo.shortcut}
        onClick={commands.redo.run}
      />
    </div>
  )
}

function HistoryButton(props: {
  name: 'Undo' | 'Redo'
  icon: React.ReactNode
  enabled: boolean
  detail: string | null
  shortcut: string | undefined
  onClick: () => void
}) {
  const { name, icon, enabled, detail, shortcut, onClick } = props
  const text = enabled ? (detail ? `${name} “${detail}”` : name) : `Nothing to ${name.toLowerCase()}`
  return (
    <Tooltip>
      {/* A disabled button gets no pointer events; the wrapper keeps its tooltip working. */}
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button variant="ghost" size="icon-sm" aria-label={name} disabled={!enabled} onClick={onClick}>
            {icon}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span>{text}</span>
        {shortcut && <Kbd>{formatShortcut(shortcut)}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}
