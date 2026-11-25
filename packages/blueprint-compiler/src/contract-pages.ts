import type { ContractOptions, ContractPage } from '@trivia/blueprint'
import type { ManifestResource } from '@trivia/contract-sync'

import type { ProjectFacts } from './facts.js'

export interface ContractPageInput {
  resource: ManifestResource
  kind: ContractPage['kind']
  facts: ProjectFacts
  options: ContractOptions
}

export type ContractPageGenerator = (input: ContractPageInput) => {
  file: string
  content: string
  component: string
  importPath: string
}

export function generateContract(
  page: ContractPage,
  resource: ManifestResource,
  facts: ProjectFacts,
  generator: ContractPageGenerator,
): ReturnType<ContractPageGenerator> {
  return generator({ resource, kind: page.kind, facts, options: page.options })
}
