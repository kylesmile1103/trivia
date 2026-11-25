import type { ContractOptions, ContractPage } from '@trivia/blueprint'
import type { ManifestField, ManifestResource } from '@trivia/contract-sync'

import { CompileError, type CompileContext, type EmittedModule } from './compile.js'
import type { ProjectFacts } from './facts.js'
import type { ImportIR } from './ir.js'
import { actionLowerer, capitalize, handlerStub } from './lower/actions.js'
import { Names } from './lower/names.js'
import { analyzePageExpressions, emitPageExpressions, routeScope } from './lower/scope.js'
import { printHook } from './print/module.js'
import { quote, statement } from './print/style.js'
import { nextPageFile } from './targets/next-refine/files.js'
import { contractRecord, type ContractRecord } from './targets/next-refine/server-data.js'
import type { RefineHookMap } from './targets/target.js'

export interface ContractPageInput {
  resource: ManifestResource
  kind: ContractPage['kind']
  facts: ProjectFacts
  options: ContractOptions
  actions?: ContractActionContent
  initialRecord?: string
}

export interface ContractActionContent {
  imports: ImportIR[]
  setup: string
  afterTable?: string
  row: string[]
  header: string[]
  dependencies: string[]
}

export type ContractPageGenerator = (input: ContractPageInput) => {
  file: string
  content: string
  component: string
  importPath: string
}

export interface RefineSnippetImport {
  name: string
  source: string
}

export interface RefineSnippetGenerator {
  column(field: ManifestField, filter: boolean): { value: string; imports: RefineSnippetImport[] }
  field(field: ManifestField, idPrefix: string): {
    rule: string
    defaultValue: string
    controller: string
    imports: RefineSnippetImport[]
  }
}

export function generateContract(
  page: ContractPage,
  resource: ManifestResource,
  context: CompileContext,
  generator: ContractPageGenerator,
  hooks: RefineHookMap,
): ReturnType<ContractPageGenerator> & Pick<EmittedModule, 'handler'> & { prefetch?: ContractRecord } {
  const { facts } = context
  const initial = hooks.initialOptions?.('initialRecord')
  const prefetch = initial && contractRecord(page, resource, context.contract)
  const input = {
    resource, kind: page.kind, facts, options: page.options,
    ...(prefetch && { initialRecord: initial.join(', ') }),
  }
  const { rowActions = [], headerActions = [] } = page.options
  if (!rowActions.length && !headerActions.length) {
    return { ...generator(input), ...(prefetch && { prefetch }) }
  }
  if (rowActions.length && page.kind !== 'list') {
    throw new CompileError('invalid_result', 'Row actions require a list page.')
  }

  // The shared scaffolder uses its established quoting convention.
  const style = { quotes: 'double', semicolons: true } as const
  const names = new Names(['columns', 'table', 'form', 'record', 'onFinish', 'formLoading', '_event', '_row'])
  const name = (preferred: string) => names.take(preferred)
  const depsOfExpressions = new Set(analyzePageExpressions(page, context.engine).flatMap(({ deps }) => deps))
  const route = routeScope(depsOfExpressions, names, hooks.router, page.route)
  const expression = emitPageExpressions(page, context.engine, { ...route.rename, event: '_event', row: '_row' },
    undefined, new Set(['event', 'row']))
  // The memoized columns need their callbacks before useTable creates the query.
  const rowRefetch = rowActions.some(({ steps }) => steps.some((step) => step.do === 'refetch' && step.query === 'list'))
  const tableRefetch = 'table.refineCore.tableQuery.refetch'
  const lower = actionLowerer({
    contract: context.contract, page: page.name,
    file: facts.target === 'next-refine' ? nextPageFile(page.route, facts, 'view.tsx') : facts.pagesDir + '/resource/' + page.kind + '.tsx',
    style, expression, name,
    ...(facts.previewDirectory && { handlerPath: facts.previewDirectory + '/handler.ts' }),
    refetch: (key, path) => {
      if (page.kind !== 'list' || key !== 'list') {
        throw new CompileError('invalid_result', 'Unknown query ' + key, {
          hint: 'Use query "list" in row or header actions on a list page.',
        })
      }
      return path[1] === 'rowActions' ? 'refetchList.current!' : tableRefetch
    },
  })
  const definitions = (group: 'rowActions' | 'headerActions', actions: typeof rowActions) => actions.map((action, index) => {
    const confirm = action.confirm
    return {
      name: name('handle' + capitalize(action.name)),
      label: action.label,
      steps: [
        ...(confirm ? [{ code: 'if (!window.confirm(' + quote(confirm, style) + ')) return' }] : []),
        ...lower.steps(action.steps, ['options', group, index, 'steps']),
      ],
    }
  })
  const row = definitions('rowActions', rowActions)
  const header = definitions('headerActions', headerActions)
  const actionHooks = [...lower.hooks.values()]
  const deps = [...route.locals, ...actionHooks.map(({ name, hook }) => hook === 'useGo' ? name
    : hook === 'useNotification' ? name + '.open' : name + '.mutateAsync')]
  const nodeType = 'MouseEvent<HTMLButtonElement>'
  const rowType = resource.entity?.typeName ?? 'Record<string, unknown>'
  const print = (action: typeof row[number], forRow: boolean): string => {
    const parameterList = '_event: ' + nodeType + (forRow ? ', _row: ' + rowType : '')
    const head = forRow
      ? 'const ' + action.name + ' = useCallback(async (' + parameterList + ') => {'
      : 'async function ' + action.name + '(' + parameterList + ') {'
    return [head, ...action.steps.map((step) => '  ' + statement((step.await ? 'await ' : '') + step.code, style)),
      forRow ? '}, [' + deps.join(', ') + ']);' : '}'].join('\n')
  }
  const button = ({ name, label }: typeof row[number], forRow: boolean): string => {
    const text = /^[^&<>{}\r\n]+$/.test(label) && label.trim() === label ? label : '{' + quote(label, style) + '}'
    const callback = '(event) => void ' + name + '(event' + (forRow ? ', row.original' : '') + ').catch(console.error)'
    return '<Button type="button" onClick={' + callback + '}>' + text + '</Button>'
  }
  const output = generator({
    ...input,
    actions: {
      imports: [
        ...route.imports, ...lower.imports, { source: 'react', name: 'MouseEvent', kind: 'type' },
        ...(row.length ? [{ source: 'react', name: 'useCallback' }] : []),
        ...(rowRefetch ? [{ source: 'react', name: 'useLayoutEffect' }, { source: 'react', name: 'useRef' }] : []),
      ],
      setup: [
        ...(rowRefetch ? ['const refetchList = useRef<() => Promise<unknown>>(null);'] : []),
        ...[...route.hooks, ...actionHooks].map((hook) => printHook(hook, style)),
        ...row.map((action) => print(action, true)),
        ...header.map((action) => print(action, false)),
      ].join('\n\n'),
      ...(rowRefetch && { afterTable: [
        'const refetchTable = ' + tableRefetch + ';',
        'useLayoutEffect(() => {',
        '  refetchList.current = () => refetchTable({ throwOnError: true });',
        '}, [refetchTable]);',
      ].join('\n') }),
      row: row.map((action) => button(action, true)),
      header: header.map((action) => button(action, false)),
      dependencies: row.map(({ name }) => name),
    },
  })
  const handler = handlerStub(page.name, lower.calls.keys(), {}, style)
  return { ...output, ...(handler && { handler }), ...(prefetch && { prefetch }) }
}
