import fs from 'node:fs'
import path from 'node:path'

import type { Plugin } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'

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
