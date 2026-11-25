import { createHash } from 'node:crypto'

import type { Target } from '../target.js'
import { files } from './files.js'
import { queryHooks, queryStatus } from './refine-hooks.js'
import { routeOps } from './routes.js'

export const viteRefine: Target = {
  name: 'vite-refine',
  files,
  routeOps,
  hooks: { queries: queryHooks, queryStatus, router: { source: 'react-router', searchTuple: true } },
  preview: (page) => ({
    route: '/__blueprint/' + page,
    id: 'blueprint-' + createHash('sha256').update(page).digest('hex').slice(0, 16),
  }),
}
