import type { ContractOptions, ContractPage } from '@trivia/blueprint'
import type { ManifestResource } from '@trivia/contract-sync'

import { CompileError, type CompileContext } from './compile.js'
import type { ProjectFacts } from './facts.js'
import type { ImportIR } from './ir.js'
import { actionLowerer, capitalize } from './lower/actions.js'
import { emitPageExpressions } from './lower/scope.js'
import { quote, statement } from './print/style.js'

export interface ContractPageInput {
  resource: ManifestResource
  kind: ContractPage['kind']
  facts: ProjectFacts
  options: ContractOptions
  actions?: ContractActionContent
}

export interface ContractActionContent {
  imports: ImportIR[]
  setup: string
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

export function generateContract(
  page: ContractPage,
  resource: ManifestResource,
  context: CompileContext,
  generator: ContractPageGenerator,
): ReturnType<ContractPageGenerator> {
  const { facts } = context
  const { rowActions = [], headerActions = [] } = page.options
  if (!rowActions.length && !headerActions.length) {
    return generator({ resource, kind: page.kind, facts, options: page.options })
  }
  if (rowActions.length && page.kind !== 'list') {
    throw new CompileError('invalid_result', 'Row actions require a list page.')
  }

  // The shared scaffolder uses its established quoting convention.
  const style = { quotes: 'double', semicolons: true } as const
  const expression = emitPageExpressions(page, context.engine, { event: '_event', row: '_row' },
    undefined, new Set(['event', 'row']))
  const used = new Set<string>()
  const name = (preferred: string) => {
    let available = preferred
    for (let index = 2; used.has(available); index++) available = preferred + index
    used.add(available)
    return available
  }
  const lower = actionLowerer({
    contract: context.contract, page: page.name, file: facts.pagesDir + '/resource/' + page.kind + '.tsx',
    style, expression, name,
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
  const hooks = [...lower.hooks.values()]
  const deps = hooks.map(({ name, hook }) => hook === 'useGo' ? name
    : hook === 'useNotification' ? name + '.open' : name + '.mutateAsync')
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
  return generator({
    resource, kind: page.kind, facts, options: page.options,
    actions: {
      imports: [
        ...lower.imports, { source: 'react', name: 'MouseEvent', kind: 'type' },
        ...(row.length ? [{ source: 'react', name: 'useCallback' }] : []),
      ],
      setup: [
        ...hooks.map(({ name, hook }) => 'const ' + name + ' = ' + hook + '();'),
        ...row.map((action) => print(action, true)),
        ...header.map((action) => print(action, false)),
      ].join('\n\n'),
      row: row.map((action) => button(action, true)),
      header: header.map((action) => button(action, false)),
      dependencies: row.map(({ name }) => name),
    },
  })
}
