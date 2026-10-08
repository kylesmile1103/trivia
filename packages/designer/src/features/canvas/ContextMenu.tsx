// The right-click menu over the canvas: what CanvasController offers for the element it opened
// on (`view.menu`). Pure presentation; the controller decides what is available and runs it.

import type { ReactNode } from 'react'
import { ArrowDownIcon, ArrowUpIcon, CornerLeftUpIcon, Trash2Icon } from 'lucide-react'

import { isMac } from '@/shared/lib/env'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'

import type { ContextMenuView, MenuAction } from './controller'

interface Props {
  menu: ContextMenuView | null
  onAction(action: MenuAction): void
  /** Escape, an outside click, or after an action: the canvas takes the keyboard back. */
  onClose(): void
}

export function CanvasContextMenu({ menu, onAction, onClose }: Props) {
  if (menu === null) return null
  return (
    // A fresh menu per right-click, anchored where it happened.
    <DropdownMenu key={menu.id} open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none absolute size-0" style={{ left: menu.at.x, top: menu.at.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={2}
        className="min-w-48"
        aria-label={`Actions for ${menu.name}`}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuLabel className="font-mono text-xs text-muted-foreground">&lt;{menu.name}&gt;</DropdownMenuLabel>
        <Item icon={<CornerLeftUpIcon />} label="Select parent" shortcut="↑" why={null} onSelect={() => onAction('selectParent')} />
        <Item icon={<ArrowUpIcon />} label="Move up" why={menu.moveUp} onSelect={() => onAction('moveUp')} />
        <Item icon={<ArrowDownIcon />} label="Move down" why={menu.moveDown} onSelect={() => onAction('moveDown')} />
        <DropdownMenuSeparator />
        <Item
          icon={<Trash2Icon />}
          label="Delete"
          shortcut={isMac ? '⌫' : 'Del'}
          why={menu.remove}
          destructive
          onSelect={() => onAction('remove')}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Item({
  icon,
  label,
  shortcut,
  why,
  destructive = false,
  onSelect,
}: {
  icon: ReactNode
  label: string
  shortcut?: string
  /** Why the action is unavailable; null when it is available. */
  why: string | null
  destructive?: boolean
  onSelect(): void
}) {
  const item = (
    <DropdownMenuItem variant={destructive ? 'destructive' : 'default'} disabled={why !== null} onSelect={onSelect}>
      {icon}
      {label}
      {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  )
  // A disabled item takes no pointer events, so the reason sits on a wrapper that does.
  return why === null ? item : <div title={`Can't ${label.toLowerCase()}: ${why}`}>{item}</div>
}
