import { hasErrors, pageDocPath, validate, type Blueprint, type ComponentManifest, type Diagnostic, type ResolvedManifests, type ValidationContext } from '@trivia/blueprint'
import type { TriviaManifest } from '@trivia/contract-sync'

import { generateContract, type ContractPageGenerator, type RefineSnippetGenerator } from './contract-pages.js'
import type { ProjectFacts } from './facts.js'
import { lowerCustom } from './lower/index.js'
import { compareBytes, moduleImports } from './print/style.js'
import { targetFor, type LoweredPage } from './targets/target.js'

export type RegistryItem = Pick<ComponentManifest['source'], 'registry' | 'item'>

export interface PageSource {
  file: string
  code: string
}

export interface EmittedModule extends PageSource {
  additional?: PageSource[]
  requires: RegistryItem[]
  component: string
  importPath: string
  route: string
  handler?: { file: string; code: string }
  warnings?: string[]
}

export interface CompileContext {
  facts: ProjectFacts
  engine: { annotate(code: string, file: string): unknown; emitExpressions(requestJson: string): string; analyzeExpressions(requestJson: string): string }
  validation?: ValidationContext
  manifests?: ResolvedManifests
  contract?: TriviaManifest | null
  generateContractPage?: ContractPageGenerator
  refineSnippets?: RefineSnippetGenerator
  /** Add node ids for selection in a virtual draft preview. Never set for eject. */
  previewNodeIds?: boolean
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
  const target = targetFor(context.facts.target)
  const entry = blueprint.docs[pageDocPath(name)]
  if (entry?.kind !== 'page') throw new CompileError('node_not_found', 'No blueprint page named ' + name)
  const diagnostics = pageDiagnostics(blueprint, name, context)
  const page = entry.doc
  if (page === null || hasErrors(diagnostics)) {
    throw new CompileError('invalid_result', 'Cannot compile blueprint page ' + name, { diagnostics })
  }
  let lowered: LoweredPage
  if (page.kind === 'custom') {
    lowered = lowerCustom(page, context, target.hooks)
  } else {
    const resource = context.contract?.resources.find((candidate) => candidate.name === page.resource)
    if (!resource) throw new CompileError('invalid_result', 'No contract resource named ' + page.resource)
    if (!context.generateContractPage) throw new CompileError('unsupported', 'The Refine generator is unavailable.')
    const generated = generateContract(page, resource, context, context.generateContractPage, target.hooks)
    lowered = { kind: 'contract', page, generated }
  }
  const [emitted, ...additional] = target.files(lowered, context.facts)
  const modules = [emitted, ...additional]
  const sources = modules.flatMap(({ code }) => moduleImports(code))
  if (sources.some((source) => source.startsWith('@trivia/'))) {
    throw new CompileError('unsupported', 'Generated modules cannot import from @trivia.')
  }
  if (page.kind !== 'custom') emitted.requires = requiredRegistryItems(sources, context.facts)
  else if (Object.values(page.nodes).some(({ type }) => context.manifests?.[type]?.composite)) {
    const requires = [...emitted.requires, ...requiredRegistryItems(sources, context.facts)]
    const byItem = new Map(requires.map((item) => [item.registry + '/' + item.item, item]))
    emitted.requires = [...byItem].sort(([a], [b]) => compareBytes(a, b)).map(([, item]) => item)
  }
  if (additional.length) emitted.additional = additional
  for (const module of modules) module.code = module.code.replace(/\r\n?/g, '\n')
  try {
    for (const module of modules) context.engine.annotate(module.code, module.file)
    if (emitted.handler) context.engine.annotate(emitted.handler.code, emitted.handler.file)
  } catch (error) {
    throw new CompileError('internal', 'Generated ' + emitted.file + ' did not parse: ' + (error as Error).message)
  }
  const warnings = diagnostics.filter(({ severity }) => severity === 'warning').map(({ message }) => message)
  if (warnings.length) emitted.warnings = warnings
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
