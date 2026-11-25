import type { Target } from '../target.js'
import { queryHooks, queryStatus } from '../vite-refine/refine-hooks.js'
import { lowerNextCustom } from './custom.js'
import { files } from './files.js'
import { routeOps } from './routes.js'

export const nextRefine: Target = {
  name: 'next-refine',
  lower: (page, context) => lowerNextCustom(page, context, nextRefine.hooks),
  files,
  routeOps,
  hooks: {
    queries: queryHooks, queryStatus, router: { source: 'next/navigation', searchTuple: false },
    initialOptions: (value) => ['initialData: ' + value, 'refetchOnMount: false'],
  },
  preview: (page) => ({ route: '/__blueprint/' + page, id: page }),
}
