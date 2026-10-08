// The designer's half of trivia_screenshot (docs/mcp.md): while connected, it keeps one long
// poll open on the plugin's GET /screenshot/next, captures the canvas when a request arrives
// and posts the PNG back (or why it couldn't).

import { canvas } from '@/shared/canvas'

import { engine } from './client'

const RETRY_MS = 3000

/** Answer screenshot requests until the returned function is called. */
export function startScreenshotRelay(): () => void {
  let stopped = false
  void (async () => {
    while (!stopped) {
      let id: string | null
      try {
        ;({ id } = await engine.nextScreenshot())
      } catch {
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS)) // the dev server is gone or restarting
        continue
      }
      if (stopped || id === null) continue
      try {
        const shot = await canvas.capture()
        await engine.postScreenshot(shot ? { id, ...shot } : { id, error: 'the canvas has no page loaded' })
      } catch (error) {
        await engine.postScreenshot({ id, error: error instanceof Error ? error.message : String(error) }).catch(() => {})
      }
    }
  })()
  return () => {
    stopped = true
  }
}
