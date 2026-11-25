import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ViteDevServer } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'

import { createViteHost } from '../src/host.js'

/** Just the parts of a dev server the host's reload touches. */
function fakeServer(modules: Record<string, string[]>, reloadModule = vi.fn(async (_mod: { id: string }) => {})) {
  const root = '/project'
  const warn = vi.fn()
  const server = {
    config: { root, server: { allowedHosts: [] }, logger: { warn } },
    environments: {
      client: {
        moduleGraph: {
          getModulesByFile: (file: string) => {
            const ids = modules[path.relative(root, file)]
            return ids ? new Set(ids.map((id) => ({ id }))) : undefined
          },
        },
        reloadModule,
      },
    },
  } as unknown as ViteDevServer
  return { server, reloadModule, warn }
}

it('reloads the modules of every file the engine wrote, without waiting for the watcher', () => {
  const { server, reloadModule } = fakeServer({ 'src/App.tsx': ['/project/src/App.tsx'], 'src/pages/Home.tsx': ['/project/src/pages/Home.tsx'] })
  const host = createViteHost(server, { uiDir: 'src/components/ui', importBase: '@/components/ui', blueprintDir: 'blueprint', warnings: [] })
  host.filesChanged?.(['src/App.tsx', 'src/pages/Home.tsx', 'trivia.manifest.json'])
  expect(reloadModule.mock.calls.map(([mod]) => mod.id)).toEqual([
    '/project/src/App.tsx', '/project/src/pages/Home.tsx',
  ])
})

const PATHS = { uiDir: 'src/components/ui', importBase: '@/components/ui', blueprintDir: 'blueprint', warnings: [] }
const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * A project on disk, its root known to the server through a symlink when `linked` (as macOS's
 * `/var` is one to `/private/var`), and a resolver that answers like Vite's: real paths, query
 * strings kept. A file `outside.tsx` sits next to the project.
 */
function resolvingServer(files: string[], answer: (specifier: string) => string | null, linked: boolean) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-host-'))
  temporary.push(base)
  const real = path.join(base, 'real')
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(real, file)), { recursive: true })
    fs.writeFileSync(path.join(real, file), 'export {}\n')
  }
  fs.writeFileSync(path.join(base, 'outside.tsx'), 'export {}\n')
  const root = linked ? path.join(base, 'link') : fs.realpathSync(real)
  if (linked) fs.symlinkSync(real, root, 'dir')
  const resolveId = vi.fn(async (specifier: string) => {
    const id = answer(specifier)
    return id === null ? null : { id: path.join(fs.realpathSync(real), id) }
  })
  const server = { config: { root, server: { allowedHosts: [] } }, pluginContainer: { resolveId } } as unknown as ViteDevServer
  return createViteHost(server, PATHS)
}

it('resolves an import to the project file Vite found, under a root reached through a symlink', async () => {
  const host = resolvingServer(['src/App.tsx', 'src/pages/accounts/list.tsx'], () => 'src/pages/accounts/list.tsx?v=1', true)
  expect(await host.resolveModule('./pages/accounts/list', 'src/App.tsx')).toBe('src/pages/accounts/list.tsx')
})

it('answers null for an import whose file is not on disk, though Vite names a path for it', async () => {
  // Vite answers a relative import it cannot find with the bare joined path.
  const host = resolvingServer(['src/App.tsx'], () => 'src/pages/accounts/list', false)
  expect(await host.resolveModule('./pages/accounts/list', 'src/App.tsx')).toBeNull()
})

it('answers null for a directory, a dependency and a file outside the project', async () => {
  const host = resolvingServer(['src/App.tsx', 'src/pages/accounts/list.tsx', 'node_modules/x/index.js'], (specifier) => specifier, false)
  expect(await host.resolveModule('src/pages/accounts', 'src/App.tsx')).toBeNull()
  expect(await host.resolveModule('node_modules/x/index.js', 'src/App.tsx')).toBeNull()
  expect(await host.resolveModule('../outside.tsx', 'src/App.tsx')).toBeNull()
})

it('logs a failed reload instead of leaving an unhandled rejection', async () => {
  const { server, warn } = fakeServer({ 'src/App.tsx': ['/project/src/App.tsx'] }, vi.fn(async (_mod: { id: string }) => { throw new Error('boom') }))
  createViteHost(server, { uiDir: 'src/components/ui', importBase: '@/components/ui', blueprintDir: 'blueprint', warnings: [] }).filesChanged?.(['src/App.tsx'])
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom')))
})
