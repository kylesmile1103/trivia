// Canvas zoom arithmetic. The store clamps to the same range (state/store.ts `setZoom`).

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 2

/** Stops for zoom in/out (⌘+ / ⌘−) and the zoom menu. */
export const ZOOM_STEPS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

/** Values within this distance count as equal (fit can produce 0.7499…). */
const EPSILON = 1e-3

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

/** The next stop above (`1`) or below (`-1`) `zoom`; off-stop values snap to the nearest stop. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next =
    direction > 0
      ? ZOOM_STEPS.find((step) => step > zoom + EPSILON)
      : ZOOM_STEPS.findLast((step) => step < zoom - EPSILON)
  return next ?? (direction > 0 ? ZOOM_MAX : ZOOM_MIN)
}

export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`
}
