import { expressionRequest, pageDocPath, type Diagnostic, type ExpressionInput, type PageDoc, type UiExpressionScope } from '@trivia/blueprint'

import { CompileError, type CompileContext } from '../compile.js'
import { compareBytes } from '../print/style.js'

interface NativeFinding {
  code: string
  severity: Diagnostic['severity']
  message: string
  start: number
  end: number
}

interface EmittedExpression {
  id: string
  ts?: string
  diagnostics?: NativeFinding[]
}

export interface ExpressionAnalysis {
  id: string
  tier: 'static' | 'server' | 'client'
  deps: string[]
  diagnostics?: NativeFinding[]
}

export function analyzePageExpressions(page: PageDoc, engine: CompileContext['engine'], ui?: UiExpressionScope): ExpressionAnalysis[] {
  const request = expressionRequest(page, ui)
  if (!request.expressions.length) return []
  request.expressions.sort((a, b) => compareBytes(a.id, b.id))
  return readResults<ExpressionAnalysis>(engine.analyzeExpressions(JSON.stringify(request)), page)
}

function readResults<T extends { id: string; diagnostics?: NativeFinding[] }>(response: string, page: PageDoc): T[] {
  const result = JSON.parse(response) as {
    ok: boolean
    data?: { unit: 'utf16'; results: T[] }
    error?: { message: string }
  }
  if (!result.ok || !result.data || result.data.unit !== 'utf16') {
    throw new CompileError('internal', result.error?.message ?? 'The expression compiler returned no output.')
  }
  const doc = pageDocPath(page.name)
  const diagnostics = result.data.results.flatMap(({ id, diagnostics }) => (diagnostics ?? []).map(({ start, end, ...finding }): Diagnostic => ({
    ...finding, doc, pointer: id, span: { start, end, unit: 'utf16' },
  })))
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    throw new CompileError('invalid_result', 'Invalid expressions in ' + page.name, { diagnostics })
  }
  return result.data.results
}

export function emitPageExpressions(
  page: PageDoc,
  engine: CompileContext['engine'],
  rename: Readonly<Record<string, string>>,
  ui?: UiExpressionScope,
  renameLocals: ReadonlySet<string> = new Set(),
  scoped?: (input: ExpressionInput) => Record<string, string>,
): (pointer: string) => string {
  const { expressions } = expressionRequest(page, ui)
  if (!expressions.length) return missing
  // The expression compiler keeps local names intact except for the aliases this emitter assigns
  // to a handler's parameters. It still tracks nested arrow bindings on those names.
  const groups = new Map<string, { rename: Record<string, string>; expressions: ExpressionInput[] }>()
  for (const input of expressions.sort((a, b) => compareBytes(a.id, b.id))) {
    const locals = Object.entries(input.locals ?? {})
    const scopedNames = scoped?.(input) ?? {}
    const aliases = Object.fromEntries([
      ...locals.filter(([name, tier]) => typeof tier === 'string' && renameLocals.has(name)).map(([name]) => [name, rename[name]!]),
      ...Object.entries(scopedNames),
    ])
    const key = JSON.stringify(aliases)
    let group = groups.get(key)
    if (!group) {
      group = { rename: { ...rename, ...aliases }, expressions: [] }
      groups.set(key, group)
    }
    group.expressions.push({ ...input, locals: Object.fromEntries(locals.filter(([name]) => !Object.hasOwn(aliases, name))) })
  }
  const codes = new Map<string, string | undefined>()
  for (const request of groups.values()) {
    const results = readResults<EmittedExpression>(engine.emitExpressions(JSON.stringify(request)), page)
    for (const { id, ts } of results) codes.set(id, ts)
  }
  return (id) => codes.get(id) ?? missing(id)
}

function missing(pointer: string): never {
  throw new CompileError('internal', 'Missing emitted expression at ' + pointer)
}

export function routeScope(deps: ReadonlySet<string>, names: import('./names.js').Names) {
  const rename: Record<string, string> = {}
  const imports: import('../ir.js').ImportIR[] = []
  const hooks: import('../ir.js').HookIR[] = []
  const locals: string[] = []
  const has = (root: string) => [...deps].some((dep) => dep.startsWith(root + '.'))
  if (has('params')) {
    const name = names.take('params')
    rename['params'] = name
    imports.push({ name: 'useParams', source: 'react-router' })
    hooks.push({ name, hook: 'useParams' })
    locals.push(name)
  }
  if (has('search')) {
    const name = names.take('searchParams')
    rename['search'] = 'Object.fromEntries(' + name + ')'
    imports.push({ name: 'useSearchParams', source: 'react-router' })
    hooks.push({ name: '[' + name + ']', hook: 'useSearchParams' })
    locals.push(name)
  }
  if (has('user')) {
    const name = names.take('user')
    rename['user'] = '(' + name + ' ?? { id: undefined, name: undefined, roles: [] })'
    imports.push({ name: 'useGetIdentity', source: '@refinedev/core' })
    hooks.push({ name: '{ data: ' + name + ' }', hook: 'useGetIdentity', type: '{ id: string; name: string; roles: string[] }' })
    locals.push(name)
  }
  return { rename, imports, hooks, locals }
}
