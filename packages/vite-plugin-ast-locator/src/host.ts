import path from 'node:path'

import type { ViteDevServer } from 'vite'
import { type DevHost, PREVIEW_PREFIX, discoverRoutes } from '@trivia/dev-service'

import type { ProjectPaths } from './options.js'

export function createViteHost(server: ViteDevServer, paths: ProjectPaths): DevHost {
  const root = server.config.root
  const resolveModule: DevHost['resolveModule'] = async (specifier, importer) => {
    const resolved = await server.pluginContainer.resolveId(specifier, path.join(root, importer))
    if (!resolved || resolved.external) return null
    const rel = path.relative(root, resolved.id.split('?')[0]!)
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
