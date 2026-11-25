import path from 'node:path'

import type { ViteDevServer } from 'vite'
import { expect, it, vi } from 'vitest'

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
  const host = createViteHost(server, { uiDir: 'src/components/ui', importBase: '@/components/ui', warnings: [] })
  host.filesChanged?.(['src/App.tsx', 'src/pages/Home.tsx', 'trivia.manifest.json'])
  expect(reloadModule.mock.calls.map(([mod]) => mod.id)).toEqual([
    '/project/src/App.tsx', '/project/src/pages/Home.tsx',
  ])
})

it('logs a failed reload instead of leaving an unhandled rejection', async () => {
  const { server, warn } = fakeServer({ 'src/App.tsx': ['/project/src/App.tsx'] }, vi.fn(async (_mod: { id: string }) => { throw new Error('boom') }))
  createViteHost(server, { uiDir: 'src/components/ui', importBase: '@/components/ui', warnings: [] }).filesChanged?.(['src/App.tsx'])
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom')))
})
