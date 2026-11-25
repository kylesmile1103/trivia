import fsp from 'node:fs/promises'
import path from 'node:path'

import type { ViteDevServer } from 'vite'
import { type DevHost, PREVIEW_PREFIX, discoverRoutes } from '@trivia/dev-service'

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
    // Reload what the engine wrote through Vite itself. Its file watcher can miss one of two
    // quick writes to a file (an edit, then its undo), and the canvas then stays on the module
    // it transformed in between, reloads included: seen on Linux CI. Reloading invalidates the
    // module and sends the update; a watcher event that does arrive just repeats it.
    filesChanged: (files) => {
      const client = server.environments.client
      for (const file of files) {
        for (const mod of client.moduleGraph.getModulesByFile(path.join(root, file)) ?? []) {
          client.reloadModule(mod).catch((error: unknown) => {
            server.config.logger.warn(`[trivia] could not reload ${file}: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
      }
    },
  }
}

/** Invalidate the shared virtual modules affected by a document or manifest change. */
export function invalidatePreviews(server: ViteDevServer, blueprintsOnly: boolean): void {
  const prefix = path.join(server.config.root, 'src', '.trivia-preview') + path.sep
  const { moduleGraph, hot } = server.environments.client
  let stale = false
  for (const module of moduleGraph.idToModuleMap.values()) {
    if (module.id?.startsWith(prefix) && module.transformResult !== null &&
        (!blueprintsOnly || module.id.slice(prefix.length).startsWith('blueprint-'))) {
      moduleGraph.invalidateModule(module)
      stale = true
    }
  }
  if (stale) hot.send({ type: 'full-reload' })
}
