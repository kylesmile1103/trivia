import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { ViteDevServer } from 'vite'
import { type DevHost, PREVIEW_PREFIX, discoverRoutes } from '@trivia/dev-service'

import { BLUEPRINT_ENTRY, BLUEPRINTS_CHANGED } from './blueprint-entry.js'
import type { ProjectPaths } from './options.js'

export function createViteHost(server: ViteDevServer, paths: ProjectPaths): DevHost {
  const root = server.config.root
  const resolveModule: DevHost['resolveModule'] = async (specifier, importer) => {
    const resolved = await server.pluginContainer.resolveId(specifier, path.join(root, importer))
    if (!resolved || resolved.external) return null
    // Vite answers a relative import it cannot find with the bare joined path, so only a file
    // on disk counts. Its ids are real paths: compare them with the root's real path (on macOS
    // the temp directory is behind the /var symlink), like the standalone resolver does.
    const file = await fsp.realpath(resolved.id.split('?')[0]!).catch(() => null)
    if (file === null || !(await fsp.stat(file)).isFile()) return null
    const rel = path.relative(await fsp.realpath(root), file)
    return rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('node_modules') ? null : rel.split(path.sep).join('/')
  }
  return {
    root,
    kind: 'vite',
    uiDir: paths.uiDir,
    importBase: paths.importBase,
    resolveModule,
    readRoutes: (source) => discoverRoutes({ ...source, root, resolve: resolveModule }),
    preview: {
      blueprints: true,
      publish: (id) => PREVIEW_PREFIX + id + '.tsx',
      invalidateBlueprints: () => invalidatePreviews(server, true),
    },
    allowedHosts: server.config.server.allowedHosts,
    // Drop the cached modules of what the engine wrote at once, as Vite's watcher listener does
    // before it sends the update (moduleGraph.onFileChange): a request right after the answer (the
    // eject dialog navigates the canvas then) must not get the module transformed before the write.
    // Nothing is sent here; the watcher's event sends the one update. Vite keys modules by real path.
    filesWritten: (files) => {
      const bases = [...new Set([root, realRoot()])]
      for (const file of files) {
        for (const base of bases) {
          for (const environment of Object.values(server.environments)) environment.moduleGraph.onFileChange(path.join(base, file))
        }
      }
    },
  }

  function realRoot(): string {
    try {
      return fs.realpathSync(root)
    } catch {
      return root
    }
  }
}

/**
 * Invalidate the shared virtual modules affected by a document change (`blueprintsOnly`) or a
 * manifest change, and reload the page when one of them was loaded. The blueprint route entry
 * is static (its one route takes the page as a parameter, and it fetches the preview when it
 * renders), so no document, page set or lock makes it stale: it is never invalidated, and a
 * canvas on another route no longer reloads on every blueprint write. A document change also
 * sends BLUEPRINTS_CHANGED, on which an entry whose preview failed to load reloads.
 */
export function invalidatePreviews(server: ViteDevServer, blueprintsOnly: boolean): void {
  const prefix = path.join(server.config.root, 'src', '.trivia-preview') + path.sep
  const { moduleGraph, hot } = server.environments.client
  let stale = false
  for (const module of moduleGraph.idToModuleMap.values()) {
    if (!module.id?.startsWith(prefix) || module.transformResult === null) continue
    const name = module.id.slice(prefix.length).split('?', 1)[0]!
    if (name === BLUEPRINT_ENTRY || (blueprintsOnly && !name.startsWith('blueprint-'))) continue
    moduleGraph.invalidateModule(module)
    stale = true
  }
  if (stale) hot.send({ type: 'full-reload' })
  if (blueprintsOnly) hot.send({ type: 'custom', event: BLUEPRINTS_CHANGED })
}
