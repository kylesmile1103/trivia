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
    preview: { blueprints: true, publish: (id) => `${PREVIEW_PREFIX}${id}.tsx` },
    allowedHosts: server.config.server.allowedHosts,
  }
}
