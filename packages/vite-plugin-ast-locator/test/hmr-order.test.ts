// A hot update waits for a transform of its module that is still running (src/hmr-order.ts), on
// a real Vite dev server. The module imports itself, as @vitejs/plugin-react's refresh footer
// makes every component module do; a test plugin holds its transform open, the way a busy server
// does, while a second write is heard.

import fs from 'node:fs'
import path from 'node:path'

import type { Plugin } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'

import { copyPlayground, request, startServer } from './helpers.js'

const HOT = 'src/Hot.tsx'
const source = (title: string) =>
  `import * as self from "/${HOT}"\n\nexport function Hot() {\n  return <p title="${title}">hot</p>\n}\n\nexport const own = self\n\nif (import.meta.hot) import.meta.hot.accept()\n`

let root: string
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** A plugin whose transform of Hot.tsx waits while `hold` is set. */
function holder(): { plugin: Plugin; hold: () => () => void; held: () => Promise<void> } {
  let gate: Promise<void> | null = null
  let reached: () => void = () => {}
  let arrived = new Promise<void>((resolve) => (reached = resolve))
  return {
    plugin: {
      name: 'test:hold-transform',
      enforce: 'pre',
      async transform(_code, id) {
        if (!id.endsWith(HOT) || gate === null) return
        reached()
        await gate
      },
    },
    hold: () => {
      let release: () => void = () => {}
      gate = new Promise<void>((resolve) => (release = resolve))
      arrived = new Promise<void>((resolve) => (reached = resolve))
      return () => {
        gate = null
        release()
      }
    },
    held: () => arrived,
  }
}

/** The URL the served module imports itself from. */
const selfImport = (body: unknown) => /import \* as self from "([^"]+)"/.exec(String(body))?.[1]

it('holds a hot update until its module\'s running transform is done, so that transform imports itself, not the update', async () => {
  root = copyPlayground()
  fs.writeFileSync(path.join(root, HOT), source('a'))
  const { plugin, hold, held } = holder()
  const server = await startServer(root, {}, {}, [plugin])
  let release = () => {}
  try {
    const file = fs.realpathSync(path.join(root, HOT))
    const client = server.vite.environments.client
    expect(selfImport((await request(server.socket, '/' + HOT)).body)).toBe('/' + HOT)
    const send = vi.spyOn(client.hot, 'send')

    // The first write: its module is asked for (an open canvas) and its transform is still running...
    fs.writeFileSync(file, source('b'))
    client.moduleGraph.onFileChange(file)
    release = hold()
    const first = request(server.socket, '/' + HOT)
    await held()
    // ...when the second write is heard.
    fs.writeFileSync(file, source('c'))
    server.vite.watcher.emit('change', file, fs.statSync(file))
    await new Promise((resolve) => setTimeout(resolve, 200))
    const sentWhileHeld = send.mock.calls.length
    release()

    // The held module imports itself at no newer timestamp than it had (none): the second
    // write's module stays the browser's to fetch with that write's update.
    const body = (await first).body
    expect(String(body)).toContain('title: "b"')
    expect(selfImport(body)).toBe('/' + HOT)
    expect(sentWhileHeld).toBe(0) // the update waited for the transform
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const [update] = send.mock.calls[0] as unknown as [{ type: string; updates: Array<{ path: string; timestamp: number }> }]
    expect(update.updates).toEqual([expect.objectContaining({ type: 'js-update', path: '/' + HOT })])
    const next = await request(server.socket, `/${HOT}?t=${update.updates[0]!.timestamp}`)
    expect(String(next.body)).toContain('title: "c"')
  } finally {
    release()
    await server.close()
  }
})

it('does not hold an update when no transform of its module is running', async () => {
  root = copyPlayground()
  fs.writeFileSync(path.join(root, HOT), source('a'))
  const server = await startServer(root)
  try {
    const file = fs.realpathSync(path.join(root, HOT))
    const client = server.vite.environments.client
    expect((await request(server.socket, '/' + HOT)).status).toBe(200)
    const send = vi.spyOn(client.hot, 'send')
    fs.writeFileSync(file, source('b'))
    server.vite.watcher.emit('change', file, fs.statSync(file))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 1_000 })
  } finally {
    await server.close()
  }
})
