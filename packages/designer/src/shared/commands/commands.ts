// Global commands: one definition each, used by the toolbar buttons, the menus that list
// them and the keyboard shortcuts, so a label and its shortcut can never disagree.

import { canvas } from '@/shared/canvas'
import { refresh } from '@/shared/engine/session'
import { redo, undo } from '@/shared/state/actions'
import { designer } from '@/shared/state/store'
import { clampZoom, stepZoom } from '@/shared/state/zoom'

export type CommandId = 'undo' | 'redo' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'zoomFit' | 'refresh'

export interface Command {
  label: string
  /** `mod+shift+z` form (see shared/lib/keyboard.ts `formatShortcut`); absent when there is none. */
  shortcut?: string
  run(): void
}

const setZoom = (zoom: number) => designer.getState().setZoom(clampZoom(zoom))

export const commands: Record<CommandId, Command> = {
  // Undo/redo always ask the engine, even when the toolbar's copy of the history says there
  // is nothing to do: another client may have edited since the last sync, and an empty
  // undo is a harmless no-op that returns the fresh history.
  undo: { label: 'Undo', shortcut: 'mod+z', run: () => void undo() },
  redo: { label: 'Redo', shortcut: 'mod+shift+z', run: () => void redo() },
  zoomIn: { label: 'Zoom in', shortcut: 'mod+=', run: () => setZoom(stepZoom(designer.getState().zoom, 1)) },
  zoomOut: { label: 'Zoom out', shortcut: 'mod+-', run: () => setZoom(stepZoom(designer.getState().zoom, -1)) },
  zoomReset: { label: 'Zoom to 100%', shortcut: 'mod+0', run: () => setZoom(1) },
  zoomFit: { label: 'Zoom to fit', shortcut: 'shift+1', run: () => setZoom(canvas.fitZoom?.() ?? 1) },
  refresh: { label: 'Reload components and history', run: () => void refresh() },
}
