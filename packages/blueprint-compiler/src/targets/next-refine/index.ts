import type { Target } from '../target.js'
import { queryHooks, queryStatus } from '../vite-refine/refine-hooks.js'
import { files } from './files.js'
import { routeOps } from './routes.js'

export const nextRefine: Target = {
  name: 'next-refine',
  files,
  routeOps,
  hooks: { queries: queryHooks, queryStatus, router: { source: 'next/navigation', searchTuple: false } },
  preview: (page) => ({ route: '/__blueprint/' + page, id: page }),
}
