// Global keyboard shortcuts. They listen on the designer window and on the canvas iframe's
// window too: in interact mode (and after any click into the app) the iframe has focus, and
// its key events never reach the parent document.

import { useEffect } from 'react'

import { hasPrimaryModifier, isTypingTarget, watchFrameWindows } from '@/shared/lib/keyboard'

import { type CommandId, commands } from './commands'
import { PALETTE_SEARCH_ID } from './search'

/** The command a key event triggers, if any. Exported for tests. */
export function commandFor(event: KeyboardEvent): CommandId | 'search' | null {
  if (event.defaultPrevented || event.isComposing || event.altKey) return null
  const typing = isTypingTarget(event.target)
  const key = event.key.toLowerCase()
  if (hasPrimaryModifier(event)) {
    // Text fields keep the browser's own undo stack for what's typed in them.
    if (key === 'z' && !typing) return event.shiftKey ? 'redo' : 'undo'
    if (key === 'y' && !event.shiftKey && !typing) return 'redo'
    if (key === '=' || key === '+') return 'zoomIn'
    if (key === '-' || key === '_') return 'zoomOut'
    if (key === '0' && !event.shiftKey) return 'zoomReset'
    return null
  }
  if (event.ctrlKey || event.metaKey || typing) return null
  // `key` is "!" for ⇧1 on most layouts; the physical key is what the shortcut means.
  if (event.shiftKey && event.code === 'Digit1') return 'zoomFit'
  if (!event.shiftKey && key === '/') return 'search'
  return null
}

function onKeyDown(event: KeyboardEvent): void {
  const command = commandFor(event)
  if (command === null) return
  event.preventDefault()
  if (command === 'search') {
    const input = document.getElementById(PALETTE_SEARCH_ID)
    if (input instanceof HTMLInputElement) {
      input.focus()
      input.select()
    }
    return
  }
  commands[command].run()
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    const unwatch = watchFrameWindows((win) => {
      win.addEventListener('keydown', onKeyDown)
      return () => win.removeEventListener('keydown', onKeyDown)
    })
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      unwatch()
    }
  }, [])
}
