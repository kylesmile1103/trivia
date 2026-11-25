import { hasErrors, pageDocPath, validate, type Blueprint, type ComponentManifest, type Diagnostic, type ResolvedManifests, type ValidationContext } from '@trivia/blueprint'
import type { TriviaManifest } from '@trivia/contract-sync'

import { generateContract, type ContractPageGenerator, type RefineSnippetGenerator } from './contract-pages.js'
import type { ProjectFacts } from './facts.js'
import { lowerCustom } from './lower/index.js'
import { compareBytes, moduleImports, restyleModule } from './print/style.js'

export type RegistryItem = Pick<ComponentManifest['source'], 'registry' | 'item'>

export interface EmittedModule {
  file: string
  code: string
  requires: RegistryItem[]
  component: string
  importPath: string
  route: string
  handler?: { file: string; code: string }
}

export interface CompileContext {
  facts: ProjectFacts
  engine: { annotate(code: string, file: string): unknown; emitExpressions(requestJson: string): string; analyzeExpressions(requestJson: string): string }
  validation?: ValidationContext
  manifests?: ResolvedManifests
  contract?: TriviaManifest | null
  generateContractPage?: ContractPageGenerator
  refineSnippets?: RefineSnippetGenerator
}

export class CompileError extends Error {
  constructor(
    readonly code: 'node_not_found' | 'invalid_result' | 'unsupported' | 'internal' | 'invalid_op' | 'conflict' | 'unresolved_component',
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
  let emitted: EmittedModule
  if (page.kind === 'custom') {
    emitted = lowerCustom(page, context)
  } else {
    const resource = context.contract?.resources.find((candidate) => candidate.name === page.resource)
    if (!resource) throw new CompileError('invalid_result', 'No contract resource named ' + page.resource)
    if (!context.generateContractPage) throw new CompileError('unsupported', 'The Refine generator is unavailable.')
    const { content, ...generated } = generateContract(page, resource, context, context.generateContractPage)
    emitted = { ...generated, code: restyleModule(content, context.facts.style), route: page.route, requires: [] }
  }
  const sources = moduleImports(emitted.code)
  if (sources.some((source) => source.startsWith('@trivia/'))) {
    throw new CompileError('unsupported', 'Generated modules cannot import from @trivia.')
  }
  if (page.kind !== 'custom') emitted.requires = requiredRegistryItems(sources, context.facts)
  emitted.code = emitted.code.replace(/\r\n?/g, '\n')
  try {
    context.engine.annotate(emitted.code, emitted.file)
    if (emitted.handler) context.engine.annotate(emitted.handler.code, emitted.handler.file)
  } catch (error) {
    throw new CompileError('internal', 'Generated ' + emitted.file + ' did not parse: ' + (error as Error).message)
  }
  return emitted
}

function requiredRegistryItems(sources: string[], facts: ProjectFacts): RegistryItem[] {
  const ui = (facts.aliases['ui'] ?? '@/components/ui') + '/'
  const refine = ui.slice(0, ui.lastIndexOf('/', ui.length - 2)) + '/refine-ui/'
  const items = new Map<string, RegistryItem>()
  for (const source of sources) {
    const registry = source.startsWith(ui) ? 'shadcn' : source.startsWith(refine) ? 'refine' : null
    if (registry === null || facts.installed.has(source)) continue
    const relative = source.slice(registry === 'shadcn' ? ui.length : refine.length)
    const item = relative.startsWith('data-table/') ? 'data-table' : relative.split('/').at(-1)!
    if (!facts.installed.has(item)) items.set(registry + '/' + item, { registry, item })
  }
  return [...items].sort(([a], [b]) => compareBytes(a, b)).map(([, item]) => item)
}
