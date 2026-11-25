import type { ContractPage } from '@trivia/blueprint'

import { nextRefine } from './next-refine/index.js'
import { viteRefine } from './vite-refine/index.js'
import type { RouteAnchor, RouteRegistration, routeOps } from './vite-refine/routes.js'
import type { queryHooks, queryStatus } from './vite-refine/refine-hooks.js'
import type { EmittedModule, PageSource, RegistryItem } from '../compile.js'
import type { ProjectFacts } from '../facts.js'
import type { ContractPageGenerator } from '../contract-pages.js'
import type { PageIR } from '../ir.js'

export type LoweredPage =
  | ({ kind: 'custom'; ir: PageIR; requires: RegistryItem[] } & Pick<EmittedModule, 'handler'>)
  | ({ kind: 'contract'; page: ContractPage; generated: ReturnType<ContractPageGenerator> & Pick<EmittedModule, 'handler'> })

export interface RefineHookMap {
  queries: typeof queryHooks
  queryStatus: typeof queryStatus
  router: { source: string; searchTuple: boolean }
}

export interface Target {
  name: ProjectFacts['target']
  files(page: LoweredPage, facts: ProjectFacts): [EmittedModule, ...PageSource[]]
  routeOps(files: readonly RouteRegistration[], anchor: RouteAnchor): ReturnType<typeof routeOps>
  hooks: RefineHookMap
  preview(page: string): { route: string; id: string }
}

export function targetFor(name: ProjectFacts['target']): Target {
  return name === 'next-refine' ? nextRefine : viteRefine
}
