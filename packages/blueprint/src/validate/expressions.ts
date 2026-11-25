import { expressionsOf } from '../expressions.js'
import { toPointer, type Diagnostic } from '../types/diagnostics.js'
import type { CustomPage, PageDoc, Query } from '../types/page.js'
import type { LayerCheck } from './context.js'

export type ExpressionBinding = (requestJson: string) => string
export type ExpressionTier = 'static' | 'server' | 'client'

type LocalTier = ExpressionTier | { from: string }
interface ExpressionShape { readonly [key: string]: ExpressionMembers | null }
type ExpressionMembers = readonly string[] | ExpressionShape
type ExpressionRoot = { tier: ExpressionTier | 'query'; members: ExpressionMembers | null }

/** Structural type of the root from exposedScope(page, manifests) in LLD-02. */
export type UiExpressionScope = { tier: 'client'; members: Readonly<Record<string, readonly string[]>> }

export interface ExpressionInput {
  id: string
  source: string
  defines?: string
  locals?: Record<string, LocalTier>
}

export interface ExpressionRequest {
  scope: { roots: Record<string, ExpressionRoot> }
  expressions: ExpressionInput[]
}

const QUERY_FIELDS: Record<Query['kind'], readonly string[]> = {
  list: ['items', 'total', 'isLoading', 'error'],
  one: ['record', 'isLoading', 'error'],
  custom: ['result', 'isLoading', 'error'],
}

function repeatLocals(page: CustomPage, node: string | undefined, skipOwn: boolean, locals: Map<string, LocalTier>): void {
  // Work from the innermost repeat outward so a nested alias shadows its outer binding.
  let id = skipOwn && node !== undefined ? page.nodes[node]?.parent : node
  const visited = new Set<string>()
  while (id != null && !visited.has(id)) {
    visited.add(id)
    const control = page.control[id]
    if (control && 'each' in control) {
      const tier = { from: toPointer(['control', id, 'each']) }
      if (!locals.has(control.as)) locals.set(control.as, tier)
      if (!locals.has('index')) locals.set('index', tier)
    }
    id = page.nodes[id]?.parent
  }
}

/** Inputs for every schema-marked expression, including the locals at that site. */
export function expressionInputs(page: PageDoc): ExpressionInput[] {
  return expressionsOf(page).map(({ pointer, expr }) => {
    const [, field, key, subfield] = pointer.split('/')
    const locals = new Map<string, LocalTier>()
    const input: ExpressionInput = { id: pointer, source: expr }
    if (page.kind === 'custom') {
      if (field === 'queries') input.defines = `data.${key}`
      if (field === 'actions') {
        locals.set('event', 'client')
        locals.set('value', 'client')
        repeatLocals(page, key?.split('.')[0], false, locals)
      } else if (field === 'bindings' || field === 'control') {
        repeatLocals(page, key, field === 'control' && subfield === 'each', locals)
      }
    } else if (field === 'options' && (key === 'rowActions' || key === 'headerActions')) {
      locals.set('event', 'client')
      if (key === 'rowActions') locals.set('row', 'client')
    }
    if (locals.size > 0) input.locals = Object.fromEntries(locals)
    return input
  })
}

export function expressionRequest(page: PageDoc, ui: UiExpressionScope = { tier: 'client', members: {} }): ExpressionRequest {
  return {
    scope: {
      roots: {
        params: { tier: 'server', members: page.route.split('/').filter((segment) => segment.startsWith(':')).map((segment) => segment.slice(1)) },
        search: { tier: 'server', members: null },
        user: { tier: 'server', members: ['id', 'name', 'roles'] },
        state: { tier: 'client', members: page.kind === 'custom' ? Object.keys(page.state) : [] },
        data: { tier: 'query', members: page.kind === 'custom'
          ? Object.fromEntries(Object.entries(page.queries).map(([name, query]) => [name, QUERY_FIELDS[query.kind]])) : {} },
        ui: { tier: ui.tier, members: ui.members },
      },
    },
    expressions: expressionInputs(page),
  }
}

export type NativeDiagnostic = Pick<Diagnostic, 'code' | 'message' | 'severity'> & { start: number; end: number }

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
export function readExpressionEnvelope<T extends { unit: 'utf16' }>(json: string): T {
  const outcome = JSON.parse(json) as Envelope<T>
  if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`)
  if (outcome.data.unit !== 'utf16') throw new Error('Unexpected expression diagnostic offset unit')
  return outcome.data
}

type AnalysisResults = { unit: 'utf16'; results: { id: string; diagnostics: NativeDiagnostic[] }[] }

/** Inject the native analyzer and the manifest's UI scope while keeping validation pure. */
export function expressionCheck(analyzeExpressions: ExpressionBinding, uiScope?: (page: PageDoc) => UiExpressionScope): LayerCheck {
  return (blueprint) => {
    const diagnostics: Diagnostic[] = []
    for (const [doc, entry] of Object.entries(blueprint.docs)) {
      if (entry.kind !== 'page' || entry.doc === null) continue
      const page = entry.doc as PageDoc
      const request = expressionRequest(page, uiScope?.(page))
      if (request.expressions.length === 0) continue
      const { unit, results } = readExpressionEnvelope<AnalysisResults>(analyzeExpressions(JSON.stringify(request)))
      for (const { id: pointer, diagnostics: findings } of results) {
        for (const { start, end, ...finding } of findings) {
          diagnostics.push({ ...finding, doc, pointer, span: { start, end, unit } })
        }
      }
    }
    return diagnostics
  }
}
