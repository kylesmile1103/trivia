import type { ContractPage, CustomPage } from '@trivia/blueprint'

import { nextRefine } from './next-refine/index.js'
import { viteRefine } from './vite-refine/index.js'
import type { RouteAnchor, RouteRegistration, resourceOps, routeOps } from './vite-refine/routes.js'
import type { queryHooks, queryStatus } from './vite-refine/refine-hooks.js'
import type { CompileContext, EmittedModule, PageSource, RegistryItem } from '../compile.js'
import type { ProjectFacts } from '../facts.js'
import type { generateContract } from '../contract-pages.js'
import type { PageIR } from '../ir.js'

export type LoweredCustomPage = { kind: 'custom'; ir: PageIR; views?: PageIR[]; requires: RegistryItem[] } & Pick<EmittedModule, 'handler'>

export type LoweredPage =
  | LoweredCustomPage
  | { kind: 'contract'; page: ContractPage; generated: ReturnType<typeof generateContract> }

export interface RefineHookMap {
  queries: typeof queryHooks
  queryStatus: typeof queryStatus
  router: { source: string; searchTuple: boolean }
  initialOptions?(value: string): string[]
}

export interface ResourceRegistration {
  path: string
  name: string
  routes: Partial<Record<ContractPage['kind'], string>>
  exists: boolean
}

export interface RoutePlan {
  files: readonly RouteRegistration[]
  resources: readonly ResourceRegistration[]
  anchor?: RouteAnchor
}

export interface Target {
  name: ProjectFacts['target']
  lower(page: CustomPage, context: CompileContext): LoweredCustomPage
  files(page: LoweredPage, facts: ProjectFacts): [EmittedModule, ...PageSource[]]
  routeOps(plan: RoutePlan): Array<ReturnType<typeof routeOps>[number] | ReturnType<typeof resourceOps>[number]>
  hooks: RefineHookMap
  preview(page: string, facts?: ProjectFacts): { route: string; id: string; directory?: string }
}

export function targetFor(name: ProjectFacts['target']): Target {
  return name === 'next-refine' ? nextRefine : viteRefine
}
