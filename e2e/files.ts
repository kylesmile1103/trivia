import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// How the tests put example files back (or set them up), and how they make sure the dev server
// serves what they wrote before the next step relies on it.
//
// Vite's watcher (the chokidar bundled in vite 8.3) emits a file's first `change` event and drops
// every further change to it for the next 50 ms, without replaying them. `fs.writeFileSync`
// truncates, then writes: two events. When the first makes the open canvas re-fetch the module
// while the file is empty and the second is dropped, Vite keeps serving a module with no exports
// to every later test ("does not provide an export named 'Dashboard'"). The plugin now replays a
// dropped change (packages/vite-plugin-ast-locator/src/watch.ts). The tests write like the
// engine: they wait out the throttle window of the change before (often the test's own last edit
// or undo), rename a whole temporary sibling over the target, then check what is served.
//
// The check: for a TypeScript or JSX module of a Vite example, GET it from the app's dev server
// and compare the source in the module's inline source map (`sourcesContent`) with the bytes
// written. That is exactly the text Vite transformed, so no distinctive string has to be picked,
// and it also catches a file that is right on disk while Vite serves an older one. Until it
// matches, poll; after TRY_MS, rewrite the file whole (a fresh change event) and poll again; after
// TRIES, fail naming the file.
//
// Where nothing can be checked, the wait and the rename are all there is: on the Next.js example
// (its dev server keeps no per-file module to ask for, and its watcher is not chokidar), and for
// files that are not modules (blueprint documents, the OpenAPI spec, the manifest), which the dev
// service reads from disk and Vite serves no transform of.
const CHANGE_THROTTLE_MS = 60
const TRY_MS = 1_000
const TRIES = 5
const POLL_MS = 50

const examples = fileURLToPath(new URL('../examples/', import.meta.url))
/** The Vite examples' dev servers, with playwright.config.ts's ports. */
const VITE_APPS: ReadonlyArray<readonly [root: string, port: string]> = [
  [path.join(examples, 'playground'), process.env.TRIVIA_APP_PORT ?? '5173'],
  [path.join(examples, 'refine-admin'), process.env.TRIVIA_REFINE_APP_PORT ?? '5174'],
  [path.join(examples, 'blueprint-kit'), process.env.TRIVIA_KIT_APP_PORT ?? '5176'],
]
const MODULE = /\.(?:tsx?|jsx|mts)$/

let sequence = 0

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const bytes = (data: string | Uint8Array) => (typeof data === 'string' ? Buffer.from(data) : Buffer.from(data))

/** Where a Vite dev server serves `file` as a module, or null when nothing can be checked. */
function moduleUrl(file: string): string | null {
  if (!MODULE.test(file) || file.endsWith('.d.ts')) return null
  for (const [root, port] of VITE_APPS) {
    const rel = path.relative(root, file)
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || rel.split(path.sep).includes('node_modules')) continue
    // encodeURI, as Vite decodes request paths with decodeURI: `%40` (from encodeURIComponent)
    // would stay `%40`, and `src/api/generated/@tanstack/…` would fall through to index.html.
    return `http://localhost:${port}` + encodeURI('/' + rel.split(path.sep).join('/'))
  }
  return null
}

/**
 * The sources Vite transformed the module at `url` from, `true` for a module with no code at run
 * time, or why there are none.
 */
async function served(url: string): Promise<string[] | true | string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    const code = await response.text()
    if (!response.ok) return `HTTP ${response.status}`
    const map = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/.exec(code)?.[1]
    // A module of types only (types.gen.ts) compiles to `export {};` and gets no source map.
    // Nothing runs from it, so there is nothing to be stale.
    if (map === undefined && /^\s*(?:export\s*\{\s*\};?)?\s*$/.test(code)) return true
    if (map === undefined) return `no inline source map (${response.headers.get('content-type')})`
    const sources = (JSON.parse(Buffer.from(map, 'base64').toString('utf8')) as { sourcesContent?: unknown[] }).sourcesContent
    return (sources ?? []).filter((source): source is string => typeof source === 'string')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** A temporary sibling with `data`, renamed over `file`: one complete change. */
function renameOver(file: string, data: Buffer): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.trivia-e2e-${process.pid}-${sequence++}.tmp`)
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/**
 * Wait until the dev server serves `file` transformed from `data`. With `rewrite`, a file still
 * stale after TRY_MS is written whole again, up to TRIES times; without, it fails after TRY_MS
 * times TRIES, the same patience.
 */
async function converge(file: string, data: Buffer, rewrite: boolean): Promise<void> {
  const url = moduleUrl(file)
  if (url === null) return
  const text = data.toString('utf8')
  for (let attempt = 1; ; attempt++) {
    let last: string[] | true | string = []
    const deadline = Date.now() + TRY_MS
    do {
      last = await served(url)
      if (last === true || (Array.isArray(last) && last.includes(text))) return
      await sleep(POLL_MS)
    } while (Date.now() < deadline)
    const why = typeof last === 'string' ? last : 'a module transformed from other content'
    if (attempt === TRIES) {
      throw new Error(`${path.relative(examples, file)}: ${new URL(url).origin} still serves ${why} after ${TRIES * TRY_MS} ms` +
        (rewrite ? ` and ${TRIES - 1} rewrites` : ', with no rewrite: the plugin did not replay a dropped change (vite-plugin-ast-locator/src/watch.ts)'))
    }
    if (rewrite) {
      console.warn(`[e2e/files] ${path.relative(examples, file)}: ${new URL(url).origin} served ${why} after ${TRY_MS} ms; rewrote it (try ${attempt + 1} of ${TRIES})`)
      renameOver(file, data)
    }
  }
}

/** Write `data` to `file` as one complete change, then wait until the dev server serves it. */
export async function writeWhole(file: string, data: string | Uint8Array): Promise<void> {
  const want = bytes(data)
  await sleep(CHANGE_THROTTLE_MS)
  renameOver(file, want)
  await converge(file, want, true)
}

/** Put `file` back to `original`: `restoreAll` for one file. */
export async function restore(file: string, original: string | Uint8Array): Promise<void> {
  await restoreAll([[file, original]])
}

/**
 * Put each file back to its original when it differs (a file that is gone counts as different).
 * Then, for every one of them, wait until the dev server serves the original: an undo whose
 * change event was dropped leaves the file right on disk and the module stale. Every file is
 * written before any is checked, so a check that fails (with every stale file named) leaves
 * none of them edited.
 */
export async function restoreAll(files: Iterable<readonly [file: string, original: string | Uint8Array]>): Promise<void> {
  const wanted = [...files].map(([file, original]) => [file, bytes(original)] as const)
  const stale = wanted.filter(([file, want]) => !(fs.existsSync(file) && fs.readFileSync(file).equals(want)))
  if (stale.length > 0) await sleep(CHANGE_THROTTLE_MS)
  for (const [file, want] of stale) renameOver(file, want)
  const failures: string[] = []
  for (const [file, want] of wanted) {
    await converge(file, want, true).catch((error: unknown) => failures.push(error instanceof Error ? error.message : String(error)))
  }
  if (failures.length > 0) throw new Error(failures.join('\n'))
}

/**
 * Write `data` over `file` in place, as VS Code and Cursor save (truncate, then write), then wait
 * until the dev server serves it, without rewriting it: when Vite heard only the truncation,
 * serving the whole file is the plugin's job (vite-plugin-ast-locator/src/watch.ts), and a stale
 * module fails here. The wait first keeps the truncation out of the throttle window of the change
 * before it, so this is an editor's save and nothing else.
 */
export async function writeInPlace(file: string, data: string): Promise<void> {
  await sleep(CHANGE_THROTTLE_MS)
  fs.writeFileSync(file, data)
  await converge(file, bytes(data), false)
}
