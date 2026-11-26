// Replays a file change that Vite's watcher dropped.
//
// The chokidar bundled in Vite 8.3 emits a file's first `change` and drops every further change
// to it for 50 ms, without replaying them (`_throttle(EV_CHANGE, path, 50)` in
// vite/dist/node/chunks/node.js). An editor that saves in place (VS Code, Cursor) truncates the
// file, then writes it: when Vite hears only the truncation, the open canvas fetches the module
// while the file is empty, and Vite keeps serving that empty module. An engine edit and its undo
// a few milliseconds apart lose the undo the same way. The update of an engine write comes only
// from this watcher, like any other write's (the host only drops the written modules from the
// cache, host.ts filesWritten): each is a temporary file renamed over the target, so its inode
// moves and the recheck below always sees it.

import fs from 'node:fs'
import path from 'node:path'

import type { FSWatcher } from 'vite'

import { NODE_MODULES, relativeToRoots } from './transform.js'

/**
 * How long after a file's last change event it is looked at again: past chokidar's 50 ms
 * window, so a change made after the look has an event of its own.
 */
export const RECHECK_MS = 100

/**
 * The delay actually used, RECHECK_MS unless a test lengthens it. Internal (the package exports
 * only its index): the real-server test makes the write it pretends was dropped only after a
 * module fetch, which under load outlasts 100 ms, where a real dropped write lands within
 * chokidar's 50 ms window.
 */
export const timing = { recheckMs: RECHECK_MS }

/**
 * After a `change` event for a project file (under one of `roots`, not in `node_modules`), stat
 * the file again RECHECK_MS later. When its mtime, size or inode moved since the event, emit the
 * change again as chokidar does (`change`, then `all`), with the new stats. Emitting on the
 * watcher, not `reloadModule`, takes the replay through Vite's whole update path: every
 * environment's `watchChange` hooks and module invalidation, then `handleHMRUpdate` with the
 * plugins' `hotUpdate` hooks (`reloadModule` only runs `updateModules` for the client's modules).
 * A replay schedules no check of its own, so it cannot loop: a later move has its own event.
 * Returns the cleanup, which clears the pending checks. Closing the watcher cleans up too
 * (chokidar's close removes every listener), which covers the old server of a restart.
 */
export function replayDroppedChanges(watcher: FSWatcher, roots: readonly string[]): () => void {
  const pending = new Map<string, NodeJS.Timeout>()
  let replaying: string | undefined
  const onChange = (file: string, stats?: fs.Stats) => {
    if (file === replaying || NODE_MODULES.test(file) || relativeToRoots(path.resolve(file), roots) === null) return
    // What chokidar read for this event; fsevents sends none, so read it now (before Vite can).
    const seen = stats ?? statOf(file)
    if (seen === null) return
    clearTimeout(pending.get(file))
    pending.set(file, setTimeout(() => {
      pending.delete(file)
      const now = statOf(file)
      if (now === null || (now.mtimeMs === seen.mtimeMs && now.size === seen.size && now.ino === seen.ino)) return
      replaying = file
      try {
        watcher.emit('change', file, now)
        watcher.emit('all', 'change', file, now)
      } finally {
        replaying = undefined
      }
    }, timing.recheckMs))
  }
  const onRemoved = (event: string | symbol, listener: unknown) => {
    if (event === 'change' && listener === onChange) stop()
  }
  const stop = () => {
    watcher.off('removeListener', onRemoved)
    watcher.off('change', onChange)
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
  }
  watcher.on('change', onChange)
  watcher.on('removeListener', onRemoved)
  return stop
}

function statOf(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null // gone: chokidar reports the unlink itself
  }
}
