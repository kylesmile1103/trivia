// Facts about the environment the designer runs in.

/** Replaced by vite.config.ts (`define`) with the TRIVIA_TARGET the dev server proxies to. */
declare const __TRIVIA_TARGET__: string | undefined

/** The user's dev server the designer proxies (e.g. `http://localhost:5173`), if known. */
export const proxyTarget: string | null = typeof __TRIVIA_TARGET__ === 'string' ? __TRIVIA_TARGET__ : null

/** `localhost:5173` for display. */
export function displayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** True on Apple platforms, where the primary shortcut modifier is ⌘ instead of Ctrl. */
export const isMac: boolean =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
