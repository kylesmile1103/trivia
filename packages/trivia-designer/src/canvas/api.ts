// Imperative canvas API for other modules (inspector, style panel). The Canvas component
// installs the real implementation on mount via `setCanvasApi`.
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
}

export function setCanvasApi(api: CanvasApi | null): void {
  current = api ?? noop
}
