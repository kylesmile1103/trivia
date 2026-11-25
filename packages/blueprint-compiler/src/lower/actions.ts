import { toPointer, type ActionStep } from '@trivia/blueprint'
import type { ManifestResource, TriviaManifest } from '@trivia/contract-sync'

import { CompileError } from '../compile.js'
import type { PrintStyle } from '../facts.js'
import type { HookIR, ImportIR, StepIR } from '../ir.js'
import { compareBytes, property, quote, statement } from '../print/style.js'
import { handlerFile, refineName, relativeModule } from '../targets/paths.js'

interface ActionContext {
  contract?: TriviaManifest | null | undefined
  page: string
  file: string
  style: PrintStyle
  expression(pointer: string): string
  name(preferred: string): string
  setter?(name: string): string | undefined
  refetch?(name: string, path: PropertyKey[]): string | undefined
  state?: string
  setters?: string
  event?: string
}

const MUTATIONS = { create: 'useCreate', update: 'useUpdate', delete: 'useDelete' } as const

export function actionLowerer(context: ActionContext) {
  const imports: ImportIR[] = []
  const hooks = new Map<string, HookIR>()
  const calls = new Map<string, string>()
  const str = (value: string) => quote(value, context.style)
  const use = (hook: string, preferred: string): string => {
    const current = hooks.get(hook)
    if (current) return current.name
    const name = context.name(preferred)
    hooks.set(hook, { name, hook })
    imports.push({ source: '@refinedev/core', name: hook })
    return name
  }

  const ref = (name: string | undefined, message: string): string => {
    if (!name) throw new CompileError('invalid_result', message)
    return name
  }

  function mutate(resource: ManifestResource, step: Extract<ActionStep, { do: 'mutate' }>, input: string, id: string | undefined): StepIR {
    for (const kind of Object.keys(MUTATIONS) as (keyof typeof MUTATIONS)[]) {
      const operation = resource.operations[kind]
      if (!operation || ![kind, operation.operationId, operation.sdkFn].includes(step.operation)) continue
      const method = use(MUTATIONS[kind], kind + 'Record')
      const args = ['resource: ' + str(refineName(resource))]
      if (kind !== 'create') args.push('id: ' + ref(id, kind + ' requires a record id'))
      if (kind !== 'delete') args.push('values: ' + input)
      return { await: true, code: method + '.mutateAsync({ ' + args.join(', ') + ' })' }
    }
    const operation = resource.customOperations.find((op) => [op.operationId, op.sdkFn].includes(step.operation))
    if (!operation || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method)) {
      throw new CompileError('invalid_result', 'Unknown mutation ' + step.operation + ' on ' + resource.name)
    }
    const url = operationUrl(operation.path, () => ref(id, step.operation + ' requires a record id'), context.style)
    const method = use('useCustomMutation', 'mutateCustom')
    return { await: true, code: method + '.mutateAsync({ url: ' + url + ', method: ' + str(operation.method.toLowerCase()) + ', values: ' + input + ' })' }
  }

  function steps(actions: readonly ActionStep[], path: PropertyKey[]): StepIR[] {
    return actions.map((step, index) => {
      const expr = (field: string) => context.expression(toPointer([...path, index, field]))
      switch (step.do) {
        case 'setState':
          return { code: ref(context.setter?.(step.name), 'Unknown state ' + step.name) + '(' + expr('value') + ')' }
        case 'navigate':
          return { code: use('useGo', 'go') + '({ to: ' + expr('to') + ' })' }
        case 'mutate': {
          const resource = context.contract?.resources.find(({ name }) => name === step.resource)
          if (!resource) throw new CompileError('invalid_result', 'No contract resource named ' + step.resource)
          return mutate(resource, step, step.input === undefined ? '{}' : expr('input'), step.id === undefined ? undefined : expr('id'))
        }
        case 'refetch':
          return { await: true, code: ref(context.refetch?.(step.query, path), 'Unknown query ' + step.query) + '()' }
        case 'toast': {
          const type = step.variant === 'error' ? 'error' : 'success'
          return { code: use('useNotification', 'notification') + '.open?.({ type: ' + str(type) + ', message: ' + expr('message') + ' })' }
        }
        case 'call': {
          let local = calls.get(step.handler)
          if (!local) {
            local = context.name('call' + capitalize(step.handler))
            calls.set(step.handler, local)
            imports.push({ name: step.handler, as: local, source: relativeModule(context.file, handlerFile(context.page)) })
          }
          return { await: true, code: local + '({ event: ' + (context.event ?? '_event')
            + ', state: ' + (context.state ?? '{}') + ', setters: ' + (context.setters ?? '{}') + ' })' }
        }
      }
    })
  }

  return { imports, hooks, steps, calls }
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function operationUrl(path: string, param: (name: string) => string, style: PrintStyle): string {
  return path.split(/\{([^}]+)\}/g).flatMap((part, index) => {
    if (index % 2) return ['encodeURIComponent(String(' + param(part) + '))']
    return part ? [quote(part, style)] : []
  }).join(' + ')
}

/** One module is shared by all call steps on a page. Eject only creates it when absent. */
export function handlerStub(
  page: string,
  calls: Iterable<string>,
  state: Readonly<Record<string, { type: string }>>,
  style: PrintStyle,
): { file: string; code: string } | undefined {
  const handlers = [...new Set(calls)].sort(compareBytes)
  if (!handlers.length) return
  const entries = Object.entries(state).sort(([a], [b]) => compareBytes(a, b))
  const shape = (format: (type: string) => string) => entries.length
    ? '{\n' + entries.map(([name, { type }]) => '    ' + statement(property(name, style) + ': ' + format(type), style)).join('\n') + '\n  }'
    : '{}'
  const code = [
    'export interface ActionContext {',
    '  ' + statement('event: unknown', style),
    '  ' + statement('state: ' + shape((type) => type), style),
    '  ' + statement('setters: ' + shape((type) => '(value: ' + type + ') => void'), style),
    '}',
    ...handlers.flatMap((name) => ['', 'export function ' + name + '(_context: ActionContext): void {}']),
    '',
  ].join('\n')
  return { file: handlerFile(page), code }
}
