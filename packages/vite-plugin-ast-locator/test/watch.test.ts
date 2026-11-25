import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FSWatcher } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RECHECK_MS, replayDroppedChanges } from '../src/watch.js'
import { copyPlayground, request, startServer } from './helpers.js'

let root: string
let stop: () => void = () => {}
afterEach(() => {
  stop()
  vi.useRealTimers()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('replaying a change the watcher dropped', () => {
  let watcher: FSWatcher
  /** Every `change` event the watcher emitted (the test's own and the replays). */
  let changes: string[]
  let all: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-watch-'))
    fs.mkdirSync(path.join(root, 'src'))
    fs.mkdirSync(path.join(root, 'node_modules/lib'), { recursive: true })
    // Just an EventEmitter, as Vite's NoopWatcher is; chokidar's emit is EventEmitter's.
    watcher = new EventEmitter() as unknown as FSWatcher
    changes = []
    all = []
    watcher.on('change', (file) => changes.push(file))
    watcher.on('all', (event, file) => all.push(`${event} ${file}`))
    stop = replayDroppedChanges(watcher, [root])
  })

  /** A file under the root, written whole. */
  const write = (rel: string, text: string) => {
    const file = path.join(root, rel)
    fs.writeFileSync(file, text)
    return file
  }
  /** What chokidar emits for a change it heard: the path and the stats it read. */
  const heard = (file: string, stats: fs.Stats | undefined = fs.statSync(file)) => {
    watcher.emit('change', file, stats)
    watcher.emit('all', 'change', file, stats)
  }

  it('replays, once, an in-place write whose second event was dropped', () => {
    const file = write('src/App.tsx', 'export const A = 1\n')
    // The editor truncates, chokidar hears that, then drops the event of the content write.
    fs.writeFileSync(file, '')
    heard(file)
    fs.writeFileSync(file, 'export const A = 2\n')
    vi.advanceTimersByTime(RECHECK_MS - 1)
    expect(changes).toEqual([file])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual([file, file])
    expect(all).toEqual([`change ${file}`, `change ${file}`])
    // The replay schedules no check of its own: nothing moved since, nothing more is emitted.
    vi.advanceTimersByTime(10 * RECHECK_MS)
    expect(changes).toEqual([file, file])
  })

  it('reads the file itself when the event carries no stats (fsevents)', () => {
    const file = write('src/App.tsx', 'export const A = 1\n')
    fs.writeFileSync(file, '')
    heard(file, undefined)
    fs.writeFileSync(file, 'export const A = 2\n')
    vi.advanceTimersByTime(RECHECK_MS)
    expect(changes).toEqual([file, file])
  })

  it('does not re-emit a file that did not move after its event', () => {
    const file = write('src/App.tsx', 'export const A = 1\n')
    heard(file)
    vi.advanceTimersByTime(10 * RECHECK_MS)
    expect(changes).toEqual([file])
  })

  it('checks only after the last event: a change that was heard is not replayed', () => {
    const file = write('src/App.tsx', '')
    heard(file)
    vi.advanceTimersByTime(RECHECK_MS / 2)
    fs.writeFileSync(file, 'export const A = 2\n')
    heard(file)
    vi.advanceTimersByTime(10 * RECHECK_MS)
    expect(changes).toEqual([file, file])
  })

  it('replays a file that moved again after a replay, once more', () => {
    const file = write('src/App.tsx', '')
    heard(file)
    fs.writeFileSync(file, 'export const A = 2\n')
    vi.advanceTimersByTime(RECHECK_MS)
    expect(changes).toHaveLength(2)
    // A later in-place write, its content event dropped again.
    fs.writeFileSync(file, '')
    heard(file)
    fs.writeFileSync(file, 'export const A = 3\n')
    vi.advanceTimersByTime(RECHECK_MS)
    expect(changes).toHaveLength(4)
  })

  it('leaves files outside the project and in node_modules alone', () => {
    const outside = path.join(os.tmpdir(), `trivia-watch-outside-${process.pid}.ts`)
    fs.writeFileSync(outside, '')
    try {
      const dependency = write('node_modules/lib/index.js', '')
      for (const file of [outside, dependency]) {
        heard(file)
        fs.writeFileSync(file, 'export const A = 2\n')
      }
      vi.advanceTimersByTime(10 * RECHECK_MS)
      expect(changes).toEqual([outside, dependency])
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })

  it('clears its pending checks when stopped', () => {
    const file = write('src/App.tsx', '')
    heard(file)
    fs.writeFileSync(file, 'export const A = 2\n')
    stop()
    vi.advanceTimersByTime(10 * RECHECK_MS)
    expect(changes).toEqual([file])
  })

  it('clears its pending checks when the watcher closes (chokidar removes every listener)', () => {
    const file = write('src/App.tsx', '')
    heard(file)
    expect(vi.getTimerCount()).toBe(1)
    watcher.removeAllListeners()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('in a Vite dev server', () => {
  const DASHBOARD = 'src/pages/Dashboard.tsx'
  /** The source Vite transformed the module it serves from, read from its inline source map. */
  async function served(socket: string): Promise<string | null> {
    const { body } = await request(socket, '/' + DASHBOARD)
    const map = /\/\/# sourceMappingURL=data:application\/json;base64,([\w+/=]+)\s*$/.exec(String(body))?.[1]
    return map === undefined ? null : (JSON.parse(Buffer.from(map, 'base64').toString('utf8')).sourcesContent?.[0] ?? null)
  }

  it('serves the whole file again after an in-place write whose second event was dropped', async () => {
    root = copyPlayground()
    const server = await startServer(root)
    try {
      // Vite keys its modules by real path (the temp directory is behind a symlink on macOS).
      const file = fs.realpathSync(path.join(root, DASHBOARD))
      const original = fs.readFileSync(file, 'utf8')
      expect(await served(server.socket)).toBe(original)
      // The truncation is heard and the open canvas fetches the module in between...
      fs.writeFileSync(file, '')
      server.vite.watcher.emit('change', file, fs.statSync(file))
      await vi.waitFor(async () => expect(await served(server.socket)).not.toBe(original))
      // ...then the content is written and its event dropped.
      fs.writeFileSync(file, original)
      await vi.waitFor(async () => expect(await served(server.socket)).toBe(original), { timeout: 2_000 })
    } finally {
      await server.close()
    }
  })

  it('clears its pending check when the server closes', async () => {
    root = copyPlayground()
    const server = await startServer(root)
    const file = fs.realpathSync(path.join(root, DASHBOARD))
    const changes: string[] = []
    server.vite.watcher.on('change', (changed) => changes.push(changed))
    fs.writeFileSync(file, '')
    server.vite.watcher.emit('change', file, fs.statSync(file))
    fs.writeFileSync(file, 'export {}\n')
    await server.close()
    await new Promise((resolve) => setTimeout(resolve, 3 * RECHECK_MS))
    // Vite's NoopWatcher (watch: null) keeps its listeners after close: a replay would show here.
    expect(changes).toEqual([file])
  })
})
