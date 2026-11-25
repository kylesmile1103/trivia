import type { RoutePlan } from '../target.js'
import { resourceOps } from '../vite-refine/routes.js'

/** App Router discovers pages from their paths. Refine only needs the resource values. */
export function routeOps({ resources }: RoutePlan) {
  return resources.flatMap(({ path, name, routes, exists }) => resourceOps(path, name, routes, exists))
}
