import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ViteDevServer } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { blueprintEntry } from '../src/blueprint-entry.js'
import { createViteHost, invalidatePreviews } from '../src/host.js'

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

describe('invalidating previews', () => {
  /**
   * Just the parts of a dev server invalidatePreviews touches: preview modules by file name, each
   * loaded (with a transform result) or not, and what the client is sent.
   */
  function previewServer(modules: Record<string, boolean>) {
    const root = '/project'
    const dir = path.join(root, 'src', '.trivia-preview')
    const graph = new Map(Object.entries(modules).map(([name, loaded]) => {
      const id = path.join(dir, name)
      return [id, { id, transformResult: loaded ? { code: '' } : null }]
    }))
    const invalidated: string[] = []
    const sent: unknown[] = []
    const server = {
      config: { root },
      environments: {
        client: {
          moduleGraph: {
            idToModuleMap: graph,
            invalidateModule: (mod: { id: string; transformResult: unknown }) => {
              invalidated.push(path.basename(mod.id))
              mod.transformResult = null
            },
          },
          hot: { send: (payload: unknown) => sent.push(payload) },
        },
      },
    } as unknown as ViteDevServer
    return { server, invalidated, sent }
  }
  const CHANGED = { type: 'custom', event: 'trivia:blueprints-changed' }
  const RELOAD = { type: 'full-reload' }

  // The route entry is static: its one route takes the page as a parameter and fetches the
  // preview when it renders, so no document, page set or lock makes it stale.
  it('leaves the blueprint route entry loaded and reloads nothing for it, but tells a failed preview', () => {
    const { server, invalidated, sent } = previewServer({ 'blueprint-route.tsx': true })
    invalidatePreviews(server, true)
    expect(invalidated).toEqual([])
    expect(sent).toEqual([CHANGED])
  })

  it('reloads once for a loaded page preview, and still leaves the entry', () => {
    const { server, invalidated, sent } = previewServer({
      'blueprint-route.tsx': true, 'blueprint-1f2e3d.tsx': true, 'blueprint-1f2e3d.css': true, 'blueprint-1f2e3d.handler.ts': true,
    })
    invalidatePreviews(server, true)
    expect(invalidated.sort()).toEqual(['blueprint-1f2e3d.css', 'blueprint-1f2e3d.handler.ts', 'blueprint-1f2e3d.tsx'])
    expect(sent).toEqual([RELOAD, CHANGED])
  })

  it('reloads nothing for a page preview that is not loaded', () => {
    const { server, invalidated, sent } = previewServer({ 'blueprint-route.tsx': true, 'blueprint-1f2e3d.tsx': false })
    invalidatePreviews(server, true)
    expect(invalidated).toEqual([])
    expect(sent).toEqual([CHANGED])
  })

  it('reloads for a loaded inferencer preview on a manifest change, without the entry or the blueprint event', () => {
    const { server, invalidated, sent } = previewServer({ 'blueprint-route.tsx': true, 'accounts-list-9a8b.tsx': true })
    invalidatePreviews(server, false)
    expect(invalidated).toEqual(['accounts-list-9a8b.tsx'])
    expect(sent).toEqual([RELOAD])
  })

  // With nothing loaded to invalidate, a failed preview would wait forever: its entry listens for
  // the blueprint event and reloads the page on it. A preview that loaded ignores the event.
  it('the route entry reloads on the next blueprint write only after a preview failed to load', () => {
    const failed = /if \(!result\.ok\) \{\n\s*import\.meta\.hot\?\.on\("trivia:blueprints-changed", \(\) => location\.reload\(\)\)\n\s*throw new Error\(result\.error\.message\)\n\s*\}/
    expect(blueprintEntry).toMatch(failed)
    expect(blueprintEntry.match(/trivia:blueprints-changed/g)).toHaveLength(1)
  })
})
