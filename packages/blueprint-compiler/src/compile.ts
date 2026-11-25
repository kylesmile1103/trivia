import { hasErrors, pageDocPath, validate, type Blueprint, type ComponentManifest, type Diagnostic, type ValidationContext } from '@trivia/blueprint'
import type { TriviaManifest } from '@trivia/contract-sync'

import { generateContract, type ContractPageGenerator } from './contract-pages.js'
import type { ProjectFacts } from './facts.js'

export type RegistryItem = Pick<ComponentManifest['source'], 'registry' | 'item'>

export interface EmittedModule {
  file: string
  code: string
  requires: RegistryItem[]
  component: string
  importPath: string
  route: string
}

export interface CompileContext {
  facts: ProjectFacts
  engine: { annotate(code: string, file: string): unknown }
  validation?: ValidationContext
  contract?: TriviaManifest | null
  generateContractPage?: ContractPageGenerator
}

export class CompileError extends Error {
  constructor(
    readonly code: 'node_not_found' | 'invalid_result' | 'unsupported' | 'internal',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'CompileError'
  }
}

export function pageDiagnostics(blueprint: Blueprint, page: string, context: CompileContext): Diagnostic[] {
  const file = pageDocPath(page)
  return validate(blueprint, context.validation).filter((diagnostic) => diagnostic.doc === file || diagnostic.doc === '')
}

export function compilePage(blueprint: Blueprint, name: string, context: CompileContext): EmittedModule {
  if (context.facts.target !== 'vite-refine') throw new CompileError('unsupported', 'This compiler targets Vite Refine apps.')
  const entry = blueprint.docs[pageDocPath(name)]
  if (entry?.kind !== 'page') throw new CompileError('node_not_found', 'No blueprint page named ' + name)
  const diagnostics = pageDiagnostics(blueprint, name, context)
  const page = entry.doc
  if (page === null || hasErrors(diagnostics)) {
    throw new CompileError('invalid_result', 'Cannot compile blueprint page ' + name, { diagnostics })
  }
  if (page.kind === 'custom') throw new CompileError('unsupported', 'Custom page printing is unavailable.')
  const resource = context.contract?.resources.find((candidate) => candidate.name === page.resource)
  if (!resource) throw new CompileError('invalid_result', 'No contract resource named ' + page.resource)
  if (!context.generateContractPage) throw new CompileError('unsupported', 'The Refine generator is unavailable.')
  const { content, ...generated } = generateContract(page, resource, context.facts, context.generateContractPage)
  try {
    context.engine.annotate(content, generated.file)
  } catch (error) {
    throw new CompileError('internal', 'Generated ' + generated.file + ' did not parse: ' + (error as Error).message)
  }
  return { ...generated, code: content, route: page.route, requires: [] }
}
