import fs from 'node:fs'
import path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RECHECK_MS } from '../src/watch.js'
import { copyPlayground, request, startServer } from './helpers.js'

// Tailwind's Vite plugin makes its stylesheet depend on every file it scans (addWatchFile), and
// Vite keeps each such file as an `asset` node imported by the stylesheet. When a scanned file is
// deleted (the undo of an eject), the stylesheet built again drops it, and its node stays in the
// graph with no importer. Vite treats a node nothing imports as a dead end and reloads the page
// when the file comes back (the next eject), though nothing on the canvas reads that node.

let root: string
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const STYLESHEET = 'src/content.css'
const PAGE = 'export function Ejected() {\n  return <p className="box">ejected</p>\n}\n'

/** A stylesheet that depends on the files in `content`, as Tailwind's does on the files it scans. */
function scanning(content: Set<string>): Plugin {
  return {
    name: 'test:scanning-stylesheet',
    transform(_code, id) {
      if (id.split('?', 1)[0]!.endsWith('/' + STYLESHEET)) for (const file of content) this.addWatchFile(file)
    },
  }
}

/** A playground copy with the stylesheet, and the page and App.tsx it depends on (real paths). */
function project() {
  root = copyPlayground()
  fs.writeFileSync(path.join(root, STYLESHEET), '.box { color: red }\n')
  const page = path.join(fs.realpathSync(root), 'src/pages/Ejected.tsx')
  fs.writeFileSync(page, PAGE)
  return { page, content: new Set([page, path.join(fs.realpathSync(root), 'src/App.tsx')]) }
}

it('sends nothing when a file comes back whose only module is a stylesheet dependency it dropped', async () => {
  const { page, content } = project()
  const server = await startServer(root, {}, {}, [scanning(content)])
  try {
    const graph = server.vite.environments.client.moduleGraph
    const asset = () => [...(graph.getModulesByFile(page) ?? [])].find((mod) => mod.type === 'asset')
    expect((await request(server.socket, '/' + STYLESHEET)).status).toBe(200)
    expect(asset()?.importers.size).toBe(1)
    // The undo deletes the page, and the stylesheet, built again, no longer depends on it.
    fs.rmSync(page)
    content.delete(page)
    server.vite.watcher.emit('unlink', page)
    await vi.waitFor(async () => {
      await request(server.socket, '/' + STYLESHEET)
      expect(asset()?.importers.size).toBe(0)
    })

    // The eject writes it again: Linux reports an add, macOS (fsevents) a change.
    const send = vi.spyOn(server.vite.environments.client.hot, 'send')
    fs.writeFileSync(page, PAGE)
    server.vite.watcher.emit('add', page, fs.statSync(page))
    server.vite.watcher.emit('change', page, fs.statSync(page))
    // Past the replay's recheck too, which finds the file as the events left it.
    await new Promise((resolve) => setTimeout(resolve, 3 * RECHECK_MS))
    expect(send.mock.calls).toEqual([])
  } finally {
    await server.close()
  }
})

it('still updates the stylesheet when a file it depends on changes', async () => {
  const { page, content } = project()
  const server = await startServer(root, {}, {}, [scanning(content)])
  try {
    expect((await request(server.socket, '/' + STYLESHEET)).status).toBe(200)
    const send = vi.spyOn(server.vite.environments.client.hot, 'send')
    fs.writeFileSync(page, PAGE.replace('ejected', 'edited'))
    server.vite.watcher.emit('change', page, fs.statSync(page))
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 3 * RECHECK_MS))
    expect(send.mock.calls).toEqual([[{ type: 'update', updates: [expect.objectContaining({ type: 'js-update', path: '/' + STYLESHEET })] }]])
  } finally {
    await server.close()
  }
})

describe('a blueprint file that Tailwind scans', () => {
  // Tailwind reloads the page when a file it scans changes and that file is not a module
  // (@tailwindcss/vite 4.3.3, hotUpdate: every module an asset, and ee() finds the file among a
  // stylesheet's scanned files), because it cannot know whether such a file is rendered. A
  // blueprint document or the lock is read from disk by the dev service and never imported by
  // the canvas, so its change becomes the CSS update of the stylesheets that scan it.
  const DRAFT = 'blueprint/pages/Draft.page.json'
  const LOCK = 'blueprint/blueprint.lock.json'
  const NOTE = 'content/note.txt'
  const draft = (className: string) => JSON.stringify({ name: 'Draft', root: { type: 'div', className } }, null, 2) + '\n'

  type Payload = { type: string; updates?: Array<{ path: string }> }
  /** A playground copy with Tailwind building STYLESHEET, a blueprint, and a note it also scans. */
  async function tailwindServer(before: Plugin[] = []) {
    root = copyPlayground()
    const real = fs.realpathSync(root)
    fs.writeFileSync(path.join(root, STYLESHEET), '@import "tailwindcss";\n')
    fs.mkdirSync(path.join(root, 'blueprint/pages'), { recursive: true })
    fs.writeFileSync(path.join(root, DRAFT), draft('p-1'))
    fs.writeFileSync(path.join(root, LOCK), '{ "pages": {} }\n')
    fs.mkdirSync(path.join(root, 'content'))
    fs.writeFileSync(path.join(root, NOTE), 'a note\n')
    const server = await startServer(root, {}, {}, [...before, ...tailwindcss()])
    const css = async () => String((await request(server.socket, '/' + STYLESHEET)).body)
    // Tailwind builds the stylesheet and makes it depend on every file it scanned.
    await css()
    const graph = server.vite.environments.client.moduleGraph
    for (const file of [DRAFT, LOCK, NOTE]) {
      expect([...(graph.getModulesByFile(path.join(real, file)) ?? [])].map((mod) => mod.type)).toEqual(['asset'])
    }
    const sent: Payload[] = []
    for (const hot of [server.vite.environments.client.hot, server.vite.hot]) {
      vi.spyOn(hot, 'send').mockImplementation((payload: unknown) => { sent.push(payload as Payload) })
    }
    /**
     * Emit the event chokidar reports for `file` (Linux's shape, on any system), then return what
     * the clients were sent, once something was or a second passed, and the replay's recheck.
     */
    const emit = async (event: 'add' | 'change' | 'unlink', file: string) => {
      const from = sent.length
      const absolute = path.join(real, file)
      server.vite.watcher.emit(event, absolute, ...(event === 'unlink' ? [] : [fs.statSync(absolute)]))
      await vi.waitFor(() => expect(sent.length).toBeGreaterThan(from), { timeout: 1_000 }).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 3 * RECHECK_MS))
      return sent.slice(from)
    }
    const updatesStylesheet = (payloads: Payload[]) =>
      payloads.some((payload) => payload.type === 'update' && payload.updates?.some((update) => update.path === '/' + STYLESHEET))
    const reloads = (payloads: Payload[]) => payloads.filter((payload) => payload.type === 'full-reload')
    return { server, real, css, emit, updatesStylesheet, reloads }
  }

  it('turns a document change into the CSS update, and a class it adds reaches the CSS', async () => {
    const { server, css, emit, updatesStylesheet, reloads } = await tailwindServer()
    try {
      expect(await css()).not.toContain('letter-spacing: 0.3125em')
      fs.writeFileSync(path.join(root, DRAFT), draft('tracking-[0.3125em]'))
      const sent = await emit('change', DRAFT)
      expect(reloads(sent)).toEqual([])
      expect(updatesStylesheet(sent)).toBe(true)
      expect(await css()).toContain('letter-spacing: 0.3125em')
    } finally {
      await server.close()
    }
  }, 30_000)

  it('reloads nothing when the lock is deleted, written again and changed (an undo, then an eject)', async () => {
    const { server, css, emit, reloads } = await tailwindServer()
    try {
      const lock = path.join(root, LOCK)
      fs.rmSync(lock)
      expect(reloads(await emit('unlink', LOCK))).toEqual([])
      await css() // the canvas fetches the updated stylesheet: Tailwind scans again, without the lock
      fs.writeFileSync(lock, '{ "pages": { "Draft": {} } }\n')
      expect(reloads(await emit('add', LOCK))).toEqual([])
      fs.writeFileSync(lock, '{ "pages": {} }\n')
      expect(reloads(await emit('change', LOCK))).toEqual([])
    } finally {
      await server.close()
    }
  }, 30_000)

  it('leaves Tailwind\'s reload for a scanned file outside the blueprint directory', async () => {
    const { server, emit, reloads } = await tailwindServer()
    try {
      fs.writeFileSync(path.join(root, NOTE), 'an edited note\n')
      expect(reloads(await emit('change', NOTE))).not.toEqual([])
    } finally {
      await server.close()
    }
  }, 30_000)

  it('passes a blueprint file that a module imports on to the later hooks as it is', async () => {
    const seen: string[][] = []
    const later: Plugin = {
      name: 'test:later-hook',
      hotUpdate({ file, modules }) {
        if (this.environment.name === 'client' && file.endsWith(DRAFT)) seen.push(modules.map((mod) => mod.type).sort())
      },
    }
    const { server, real, emit } = await tailwindServer([later])
    try {
      fs.writeFileSync(path.join(root, 'src/uses-draft.ts'), 'import draft from "../blueprint/pages/Draft.page.json"\nexport default draft\n')
      expect((await request(server.socket, '/src/uses-draft.ts')).status).toBe(200)
      expect((await request(server.socket, '/blueprint/pages/Draft.page.json?import')).status).toBe(200)
      const modules = server.vite.environments.client.moduleGraph.getModulesByFile(path.join(real, DRAFT)) ?? []
      expect([...modules].map((mod) => mod.type).sort()).toEqual(['asset', 'js'])
      await emit('change', DRAFT)
      expect(seen).toEqual([['asset', 'js']])
    } finally {
      await server.close()
    }
  }, 30_000)
})
