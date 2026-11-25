import { expressionRequest, pageDocPath, type Diagnostic, type PageDoc, type UiExpressionScope } from '@trivia/blueprint'

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

export function emitPageExpressions(
  page: PageDoc,
  engine: CompileContext['engine'],
  rename: Readonly<Record<string, string>>,
  ui?: UiExpressionScope,
  renameLocals: ReadonlySet<string> = new Set(),
): (pointer: string) => string {
  const { expressions } = expressionRequest(page, ui)
  if (!expressions.length) return missing
  // The expression compiler keeps local names intact except for the aliases this emitter assigns
  // to a handler's parameters. It still tracks nested arrow bindings on those names.
  const inputs = expressions.map(({ locals, ...input }) => ({
    ...input,
    ...(locals && { locals: Object.fromEntries(Object.entries(locals).filter(([name]) => !renameLocals.has(name))) }),
  })).sort((a, b) => compareBytes(a.id, b.id))
  const result = JSON.parse(engine.emitExpressions(JSON.stringify({ expressions: inputs, rename }))) as {
    ok: boolean
    data?: { unit: 'utf16'; results: EmittedExpression[] }
    error?: { message: string }
  }
  if (!result.ok || !result.data || result.data.unit !== 'utf16') {
    throw new CompileError('internal', result.error?.message ?? 'The expression emitter returned no output.')
  }
  const doc = pageDocPath(page.name)
  const diagnostics = result.data.results.flatMap(({ id, diagnostics }) => (diagnostics ?? []).map(({ start, end, ...finding }): Diagnostic => ({
    ...finding, doc, pointer: id, span: { start, end, unit: 'utf16' },
  })))
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    throw new CompileError('invalid_result', 'Cannot emit expressions for ' + page.name, { diagnostics })
  }
  const codes = new Map(result.data.results.map(({ id, ts }) => [id, ts]))
  return (id) => codes.get(id) ?? missing(id)
}

function missing(pointer: string): never {
  throw new CompileError('internal', 'Missing emitted expression at ' + pointer)
}
