import fs from 'node:fs'
import path from 'node:path'

// How the tests put example files back (or set them up), so the dev servers see whole files.
//
// Vite's watcher (the chokidar bundled in vite 8.3) emits a file's first `change` event and drops
// every further change to it for the next 50 ms, without replaying them. `fs.writeFileSync`
// truncates, then writes: two events. The first makes the open canvas re-fetch the module while
// the file is empty, and the second, the one with the content, is dropped, so Vite keeps serving
// a module with no exports to every later test ("does not provide an export named 'Dashboard'").
// The engine never writes like that: it renames a whole temporary file over the target. Do the
// same here, after waiting out the throttle window of the change that came just before (often
// the test's own last edit or undo).
const CHANGE_THROTTLE_MS = 60
let sequence = 0

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Write `data` to `file` as one complete change: a temporary sibling renamed over it. */
export function writeWhole(file: string, data: string | Uint8Array): void {
  pause(CHANGE_THROTTLE_MS)
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.trivia-e2e-${process.pid}-${sequence++}.tmp`)
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** Put `file` back to `original` when it differs (a file that is gone counts as different). */
export function restore(file: string, original: string | Uint8Array): void {
  const now = fs.existsSync(file) ? fs.readFileSync(file) : null
  const want = typeof original === 'string' ? Buffer.from(original) : Buffer.from(original)
  if (now === null || !now.equals(want)) writeWhole(file, original)
}
