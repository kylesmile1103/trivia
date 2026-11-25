import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { loadEngine } from '@trivia/dev-service'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { createNextHost } from '../src/host.js'
import { runLauncher } from '../src/launcher.js'

let root: string
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trivia-next-launcher-')))
  await fs.mkdir(path.join(root, 'app'))
})
afterEach(async () => fs.rm(root, { recursive: true, force: true }))

it.each(['app', 'pages'])('starts a Next %s project and stops both processes on SIGTERM', async (router) => {
  if (router === 'pages') await fs.rename(path.join(root, 'app'), path.join(root, 'pages'))
  const next = path.join(root, 'node_modules/next/dist/bin')
  await fs.mkdir(next, { recursive: true })
  await fs.writeFile(path.join(next, 'next'), `
const fs = require('node:fs')
process.on('SIGTERM', () => {
  fs.writeFileSync('next-stopped', 'yes')
  process.exit(0)
})
console.log('fixture next args ' + JSON.stringify(process.argv.slice(2)))
setInterval(() => {}, 1000)
`)
  const bin = path.resolve(import.meta.dirname, '../bin/trivia-next.js')
  const child = spawn(process.execPath, [bin, 'dev', '--port', '5329', '--service-port', '0', '--webpack'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  let output = ''
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  try {
    await expect.poll(() => output).toContain('fixture next args ["dev","--hostname","127.0.0.1","--port","5329","--webpack"]')
    const mcp = output.match(/Trivia MCP: (http:\/\/127\.0\.0\.1:\d+)\/@trivia\/mcp/)?.[1]
    expect(mcp).toBeDefined()
    expect(await (await fetch(`${mcp}/@trivia/api/health`)).json()).toMatchObject({ ok: true, data: { root } })
    if (router === 'pages') {
      expect(await (await fetch(`${mcp}/@trivia/api/routes`)).json()).toEqual({ ok: true, data: [] })
      expect(output).toContain('Pages Router is unsupported')
    }
    child.kill('SIGTERM')
    expect(await exited).toEqual([0, null])
    expect(await fs.readFile(path.join(root, 'next-stopped'), 'utf8')).toBe('yes')
    await expect(fetch(`${mcp}/@trivia/api/health`)).rejects.toThrow()
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited
    }
  }
})

it('refuses the same explicit port for the app and dev service before starting either', async () => {
  const occupied = net.createServer()
  await once(occupied.listen(0, '127.0.0.1'), 'listening')
  try {
    const port = String((occupied.address() as net.AddressInfo).port)
    await expect(runLauncher(['dev', '--port', port, '--service-port', port])).rejects.toThrow(/must use different ports/)
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()))
  }
})

it('publishes compiled pages at the escaped App Router path and removes its own files', async () => {
  const host = createNextHost(root, await loadEngine())
  const code = 'export default function Preview() { return <main>Preview</main> }\n'
  const existing = path.join(root, 'app/(blueprint-preview)/%5F_blueprint/Other/page.tsx')
  await fs.mkdir(path.dirname(existing), { recursive: true })
  await fs.writeFile(existing, code)
  const id = '0123456789abcdef'
  expect(await host.preview.publish(id, { code, component: 'Preview' })).toBe(`/__blueprint/refine-${id}`)
  const file = path.join(root, `app/(blueprint-preview)/%5F_blueprint/refine-${id}/page.tsx`)
  expect(await fs.readFile(file, 'utf8')).toBe(code)
  await host.preview.close?.()
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readFile(existing, 'utf8')).toBe(code)
})
