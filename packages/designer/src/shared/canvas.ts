// Imperative canvas API for other features (inspector, style panel, commands). The canvas
// feature's Canvas component installs the real implementation on mount via `setCanvasApi`, so
// its users depend on this contract, not on the canvas.
//
// Two-phase editing (adopted from Onlook): during a gesture or while typing, preview the
// change directly in the iframe DOM; write to source only on commit (mouseup/blur/enter).
// Note: Tailwind JIT only has CSS for classes already in the user's source, so previews of
// *new* utility values must use real CSS (`previewStyle`); `previewClassName` is exact only
// for classes that already exist in the app's CSS.

export interface CanvasApi {
  /** Iframe DOM elements currently carrying `locator` (several when rendered by .map()). */
  elements(locator: string): HTMLElement[]
  /** Temporarily replace the user-authored className tokens of `locator`; null restores. */
  previewClassName(locator: string, previous: string, next: string | null): void
  /** Temporarily apply CSS declarations (kebab-case property → value); null restores. */
  previewStyle(locator: string, style: Record<string, string> | null): void
  /** Drop every preview (called on commit and after HMR). */
  clearPreviews(): void
  /**
   * The zoom at which the whole canvas frame fits the visible canvas area, for the toolbar's
   * "Zoom to fit". Optional: a canvas whose frame always fills its area at 100% can omit it
   * (or return null), and fit then means 100%.
   */
  fitZoom?(): number | null
}

const noop: CanvasApi = {
  elements: () => [],
  previewClassName: () => {},
  previewStyle: () => {},
  clearPreviews: () => {},
}

let current: CanvasApi = noop

export const canvas: CanvasApi = {
  elements: (l) => current.elements(l),
  previewClassName: (l, p, n) => current.previewClassName(l, p, n),
  previewStyle: (l, s) => current.previewStyle(l, s),
  clearPreviews: () => current.clearPreviews(),
  fitZoom: () => current.fitZoom?.() ?? null,
}

export function setCanvasApi(api: CanvasApi | null): void {
  current = api ?? noop
}
