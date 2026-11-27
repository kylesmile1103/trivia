// Holds a hot update back until the transforms of its modules that are still running have
// finished.
//
// @vitejs/plugin-react 6 ends every component module with an import of itself
// (`import * as __vite_react_currentExports from "/src/pages/Dashboard.tsx"`), and Vite's import
// analysis stamps an import with the imported module's latest HMR timestamp (`?t=`), read when it
// runs: late in a transform, after the file was read (vite/dist/node/chunks/node.js,
// `importedMod.lastHMRTimestamp`). When a second write lands while the first write's module is
// still being transformed (an edit, then its undo a few milliseconds later), that module comes out
// with the first write's source and an import of the second write's URL. The browser runs the
// second write's module first, as a dependency, then the first's body, whose React Refresh
// registration wins: the canvas renders the first write, and the second write's own update finds
// its module already loaded. An e2e trace showed it: a Layers move, then its undo 24 ms later, and
// the canvas kept the move.
//
// Vite awaits every plugin's `hotUpdate` hook before `updateModules` stamps the new timestamp
// (`handleHMRUpdate`), so waiting there for the module's pending transform lets that transform
// read the timestamp it was asked for. Updates go out in the order their changes came, and none
// waits longer than PENDING_TRANSFORM_MS for a transform that never ends.

import type { EnvironmentModuleNode } from 'vite'

/** The longest a hot update waits for a transform of its module that is still running. */
export const PENDING_TRANSFORM_MS = 5_000

/**
 * Vite's in-flight transforms by URL (`DevEnvironment._pendingRequests`, not public API). Absent
 * or of another shape in a Vite that changed it: then nothing waits, as before this module.
 */
function pendingTransforms(environment: unknown): Map<string, { request: Promise<unknown> }> | null {
  const pending = (environment as { _pendingRequests?: unknown } | undefined)?._pendingRequests
  return pending instanceof Map ? (pending as Map<string, { request: Promise<unknown> }>) : null
}

/**
 * A queue of hot updates: `settle(environment, modules)` resolves once every update queued before
 * it has, and every transform of `modules` that was running when its turn came has finished
 * (fulfilled or not), or after PENDING_TRANSFORM_MS.
 */
export function hotUpdateOrder(): (environment: unknown, modules: readonly EnvironmentModuleNode[]) => Promise<void> {
  let queue: Promise<void> = Promise.resolve()
  return (environment, modules) => {
    const turn = queue.then(async () => {
      const pending = pendingTransforms(environment)
      if (pending === null) return
      const running = modules.flatMap((mod) => {
        const request = mod.url ? pending.get(mod.url)?.request : undefined
        return request ? [request] : []
      })
      if (running.length === 0) return
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled(running),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PENDING_TRANSFORM_MS)
        }),
      ])
      clearTimeout(timer)
    })
    queue = turn
    return turn
  }
}
