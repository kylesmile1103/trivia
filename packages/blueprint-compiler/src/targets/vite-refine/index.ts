import { createHash } from 'node:crypto'

import type { Target } from '../target.js'
import { files } from './files.js'
import { queryHooks, queryStatus } from './refine-hooks.js'
import { resourceOps, routeOps } from './routes.js'

export const viteRefine: Target = {
  name: 'vite-refine',
  files,
  routeOps: ({ files, resources, anchor }) => [
    ...resources.flatMap(({ path, name, routes, exists }) => resourceOps(path, name, routes, exists)),
    ...(anchor ? routeOps(files, anchor) : []),
  ],
  hooks: { queries: queryHooks, queryStatus, router: { source: 'react-router', searchTuple: true } },
  preview: (page) => ({
    route: '/__blueprint/' + page,
    id: 'blueprint-' + createHash('sha256').update(page).digest('hex').slice(0, 16),
  }),
}
