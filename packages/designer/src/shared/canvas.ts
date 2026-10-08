// Imperative canvas API for other features (inspector, style panel, commands). The canvas
// feature's Canvas component installs the real implementation on mount via `setCanvasApi`, so
// its users depend on this contract, not on the canvas.
//
// Two-phase editing (adopted from Onlook): during a gesture or while typing, preview the
// change directly in the iframe DOM; write to source only on commit (mouseup/blur/enter).
// Note: Tailwind JIT only has CSS for classes already in the user's source, so previews of
// *new* utility values must use real CSS (`previewStyle`); `previewClassName` is exact only
// for classes that already exist in the app's CSS.

/** One element of the canvas as the user wrote it (a usage site), for the layers panel. */
export interface Layer {
  locator: string
  /** Tag name: the engine's when the canvas has looked it up, else the DOM's best guess. */
  name: string
  /** Elements rendered for it: several inside `.map()`. */
  count: number
  /** Its text when it holds nothing but text (a label), shortened; else null. */
  text: string | null
  children: Layer[]
}

export interface CanvasApi {
  /** Iframe DOM elements currently carrying `locator` (several when rendered by .map()). */
  elements(locator: string): HTMLElement[]
  /** Temporarily replace the user-authored className tokens of `locator`; null restores. */
  previewClassName(locator: string, previous: string, next: string | null): void
  /** Temporarily apply CSS declarations (kebab-case property → value); null restores. */
  previewStyle(locator: string, style: Record<string, string> | null): void
  /** Drop every preview (called on commit and after HMR). */
  clearPreviews(): void
  /** The rendered app's element tree, as selection sees it (usage sites, nested as rendered). */
  layers(): Layer[]
  /** A PNG (data URL) of the app's whole page, up to 4000 px tall; null without a page. */
  capture(): Promise<{ png: string; width: number; height: number } | null>
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
  layers: () => [],
  capture: async () => null,
}

let current: CanvasApi = noop

export const canvas: CanvasApi = {
  elements: (l) => current.elements(l),
  previewClassName: (l, p, n) => current.previewClassName(l, p, n),
  previewStyle: (l, s) => current.previewStyle(l, s),
  clearPreviews: () => current.clearPreviews(),
  layers: () => current.layers(),
  capture: () => current.capture(),
  fitZoom: () => current.fitZoom?.() ?? null,
}

export function setCanvasApi(api: CanvasApi | null): void {
  current = api ?? noop
}
