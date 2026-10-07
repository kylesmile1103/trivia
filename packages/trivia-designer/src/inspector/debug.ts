// Dev-only debug handle, `window.__trivia`, for the browser console and e2e tests.
//
// e2e/inspector.spec.ts uses it to read the store and, when the build has no canvas overlay to
// click through (the canvas lives in another workstream), to drive selection and load prop
// schemas the way the canvas and the shell would. It is not part of the product surface and is
// never installed in a production build.

import { engine } from '@/bridge/client'
import { designer, type DesignerState } from '@/state/store'

export interface TriviaDebugHandle {
  /** A snapshot of the designer store. */
  state(): DesignerState
  /** Select a node by locator, as a canvas click does. */
  select(locator: string | null): void
  /** Fetch prop schemas into the store, as the shell does on startup; resolves to their count. */
  loadComponents(): Promise<number>
}

declare global {
  interface Window {
    __trivia?: TriviaDebugHandle
  }
}

export function installDebugHandle(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return
  window.__trivia = {
    state: () => designer.getState(),
    select: (locator) => designer.getState().select(locator),
    loadComponents: async () => {
      const components = await engine.components()
      designer.getState().setComponents(components)
      return components.length
    },
  }
}
