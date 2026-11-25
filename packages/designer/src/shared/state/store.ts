// Shared designer state. Canvas, inspector, palette and toolbar all read/write through here.

import { create } from 'zustand'

import type { ComponentSchema, Health, HistoryState, NodeDetails, Placement } from '@/shared/engine/types'
import type { Template } from '@/shared/template'

export type LeftPanel = 'components' | 'layers' | 'pages' | 'data' | 'blueprint'

export type DragSource =
  | { kind: 'palette'; template: Template }
  | { kind: 'node'; locator: string; name: string }

/** Where a drop would land; `rect` is in overlay (designer viewport) coordinates. */
export interface DropTarget {
  target: string
  placement: Placement
  rect: { x: number; y: number; width: number; height: number }
}

/** An edit the action bus sent that changed files: which ones, and when it was sent (`performance.now()`). */
export interface EditReceipt {
  files: readonly string[]
  sentAt: number
}

export interface DesignerState {
  health: Health | null
  components: ComponentSchema[]
  componentsByName: Record<string, ComponentSchema>
  /** Selected node locator (usage site, never inside uiDir). */
  selected: string | null
  /**
   * A canvas press made while the app was re-rendering is waiting to select what it landed on
   * (features/canvas/controller.ts). Meanwhile nothing else claims the selection on its behalf: the action
   * bus doesn't follow an edit's result. Any `select` supersedes the press.
   */
  pressPending: boolean
  hovered: string | null
  /** Engine details for `selected`; refreshed on selection change and after HMR. */
  details: NodeDetails | null
  history: HistoryState
  /**
   * The edit behind the latest `history`, when the action bus made it; null when the history
   * came from anywhere else. The canvas uses it to recognise that edit's hot update.
   */
  lastEdit: EditReceipt | null
  /** design: overlay captures pointer events; interact: events pass through to the app. */
  mode: 'design' | 'interact'
  /** The left column's tab. */
  panel: LeftPanel
  zoom: number
  drag: DragSource | null
  drop: DropTarget | null
  /** Bumped by the canvas whenever the iframe DOM changes (HMR); consumers re-measure/refetch. */
  revision: number
  /** Where the canvas is in the app: path, query and hash; null before a document has loaded. */
  canvasPath: string | null
  /** A marked draft element selected in the canvas, consumed by the Blueprint tab. */
  previewNode: { page: string; node: string } | null
  /**
   * Set around undo/redo: the tag name of the selected node before the history jump. Locators
   * are positions, so after the jump the same locator can name a different element; when the
   * refreshed details disagree, the selection is dropped instead of silently retargeted.
   */
  expectedSelectedName: string | null

  setHealth(health: Health | null): void
  setComponents(components: ComponentSchema[]): void
  select(locator: string | null): void
  setPressPending(pending: boolean): void
  hover(locator: string | null): void
  setDetails(details: NodeDetails | null): void
  setHistory(history: HistoryState, edit?: EditReceipt): void
  setMode(mode: 'design' | 'interact'): void
  setPanel(panel: LeftPanel): void
  setZoom(zoom: number): void
  setDrag(drag: DragSource | null): void
  setDrop(drop: DropTarget | null): void
  bumpRevision(): void
  setCanvasPath(path: string | null): void
  setPreviewNode(selection: DesignerState['previewNode']): void
  expectSelectedName(name: string | null): void
}

export const useDesigner = create<DesignerState>()((set) => ({
  health: null,
  components: [],
  componentsByName: {},
  selected: null,
  pressPending: false,
  hovered: null,
  details: null,
  history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
  lastEdit: null,
  mode: 'design',
  panel: 'components',
  zoom: 1,
  drag: null,
  drop: null,
  revision: 0,
  canvasPath: null,
  previewNode: null,
  expectedSelectedName: null,

  setHealth: (health) => set({ health }),
  setComponents: (components) =>
    set({ components, componentsByName: Object.fromEntries(components.map((c) => [c.name, c])) }),
  select: (selected) =>
    set((s) => {
      if (s.selected !== selected) return { selected, details: null, expectedSelectedName: null, pressPending: false }
      return s.pressPending ? { pressPending: false } : s
    }),
  setPressPending: (pressPending) => set({ pressPending }),
  hover: (hovered) => set({ hovered }),
  setDetails: (details) =>
    set((s) => {
      const expected = s.expectedSelectedName
      if (expected === null || details === null || details.locator !== s.selected) return { details }
      return details.name === expected
        ? { details, expectedSelectedName: null }
        : { details: null, selected: null, expectedSelectedName: null }
    }),
  setHistory: (history, edit) => set({ history, lastEdit: edit ?? null }),
  setMode: (mode) => set({ mode, hovered: null }),
  setPanel: (panel) => set({ panel }),
  setZoom: (zoom) => set({ zoom: Math.min(2, Math.max(0.25, zoom)) }),
  setDrag: (drag) => set({ drag, drop: drag ? null : null }),
  setDrop: (drop) => set({ drop }),
  // A re-render may come from an edit made elsewhere (the user's IDE, an agent): the selected
  // locator may now name another element, which the next details then reveal (setDetails).
  bumpRevision: () =>
    set((s) => ({
      revision: s.revision + 1,
      expectedSelectedName: s.expectedSelectedName ?? (s.details !== null && s.details.locator === s.selected ? s.details.name : null),
    })),
  setPreviewNode: (previewNode) => set(previewNode ? { previewNode, panel: 'blueprint' } : { previewNode }),
  setCanvasPath: (canvasPath) => set((s) => (s.canvasPath === canvasPath ? s : { canvasPath })),
  expectSelectedName: (expectedSelectedName) => set({ expectedSelectedName }),
}))

/** Non-React access (event handlers, the action bus). */
export const designer = useDesigner
