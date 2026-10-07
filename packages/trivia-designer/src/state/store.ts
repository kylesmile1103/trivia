// Shared designer state. Canvas, inspector, palette and toolbar all read/write through here.

import { create } from 'zustand'

import type { ComponentSchema, Health, HistoryState, NodeDetails, Placement } from '@/bridge/types'
import type { Template } from '@/registry/templates'

export type DragSource =
  | { kind: 'palette'; template: Template }
  | { kind: 'node'; locator: string; name: string }

/** Where a drop would land; `rect` is in overlay (designer viewport) coordinates. */
export interface DropTarget {
  target: string
  placement: Placement
  rect: { x: number; y: number; width: number; height: number }
}

export interface DesignerState {
  health: Health | null
  components: ComponentSchema[]
  componentsByName: Record<string, ComponentSchema>
  /** Selected node locator (usage site, never inside uiDir). */
  selected: string | null
  hovered: string | null
  /** Engine details for `selected`; refreshed on selection change and after HMR. */
  details: NodeDetails | null
  history: HistoryState
  /** design: overlay captures pointer events; interact: events pass through to the app. */
  mode: 'design' | 'interact'
  zoom: number
  drag: DragSource | null
  drop: DropTarget | null
  /** Bumped by the canvas whenever the iframe DOM changes (HMR); consumers re-measure/refetch. */
  revision: number

  setHealth(health: Health | null): void
  setComponents(components: ComponentSchema[]): void
  select(locator: string | null): void
  hover(locator: string | null): void
  setDetails(details: NodeDetails | null): void
  setHistory(history: HistoryState): void
  setMode(mode: 'design' | 'interact'): void
  setZoom(zoom: number): void
  setDrag(drag: DragSource | null): void
  setDrop(drop: DropTarget | null): void
  bumpRevision(): void
}

export const useDesigner = create<DesignerState>()((set) => ({
  health: null,
  components: [],
  componentsByName: {},
  selected: null,
  hovered: null,
  details: null,
  history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
  mode: 'design',
  zoom: 1,
  drag: null,
  drop: null,
  revision: 0,

  setHealth: (health) => set({ health }),
  setComponents: (components) =>
    set({ components, componentsByName: Object.fromEntries(components.map((c) => [c.name, c])) }),
  select: (selected) => set((s) => (s.selected === selected ? s : { selected, details: null })),
  hover: (hovered) => set({ hovered }),
  setDetails: (details) => set({ details }),
  setHistory: (history) => set({ history }),
  setMode: (mode) => set({ mode, hovered: null }),
  setZoom: (zoom) => set({ zoom: Math.min(2, Math.max(0.25, zoom)) }),
  setDrag: (drag) => set({ drag, drop: drag ? null : null }),
  setDrop: (drop) => set({ drop }),
  bumpRevision: () => set((s) => ({ revision: s.revision + 1 })),
}))

/** Non-React access (event handlers, the action bus). */
export const designer = useDesigner
