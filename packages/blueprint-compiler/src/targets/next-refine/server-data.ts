import { toPointer, type CustomPage, type Query } from '@trivia/blueprint'
import type { ManifestOperation, ManifestResource, TriviaManifest } from '@trivia/contract-sync'

import { CompileError, type CompileContext } from '../../compile.js'
import type { ProjectFacts } from '../../facts.js'
import type { ImportIR } from '../../ir.js'
import type { ExpressionAnalysis } from '../../lower/scope.js'
import { compareBytes, property, statement } from '../../print/style.js'

export interface ServerQuery {
  key: string
  query: Query
  operation: ManifestOperation
  deps: string[]
  name: string
  loader: string
}

export function queryFields(kind: Query['kind'], value: string): Record<string, string> {
  const data = value + '?.data'
  return {
    ...(kind === 'list' ? { items: '(' + data + ' ?? [])', total: '(' + value + '?.total ?? 0)' }
      : kind === 'one' ? { record: data } : { result: '(' + data + ' ?? {})' }),
    isLoading: 'false', error: 'null',
  }
}

function operationFor(query: Query, resource: ManifestResource): ManifestOperation | null | undefined {
  if (query.kind === 'one') return resource.operations.get
  if (query.kind === 'list') return resource.operations.list
  return resource.customOperations.find((operation) => [operation.operationId, operation.sdkFn].includes(query.operation))
}

export function serverQueries(page: CustomPage, analysis: readonly ExpressionAnalysis[], contract?: TriviaManifest | null): ServerQuery[] {
  const manual = new Set(Object.values(page.actions).flatMap((steps) =>
    steps.flatMap((step) => step.do === 'refetch' ? [step.query] : [])))
  const candidates = Object.entries(page.queries).sort(([a], [b]) => compareBytes(a, b)).flatMap(([key, query]) => {
    const resource = contract?.resources.find(({ name }) => name === query.resource)
    const operation = resource && operationFor(query, resource)
    const sites = analysis.filter(({ id }) => id.startsWith('/queries/' + key + '/'))
    if (!operation || operation.method !== 'GET' || manual.has(key) || sites.some(({ tier }) => tier === 'client')) return []
    const deps = [...new Set(sites.flatMap(({ deps }) => deps))]
    return [{ key, query, operation, deps, sites, name: '__bpQuery_' + key, loader: '__bpLoad_' + key }]
  })
  const wanted = new Set(candidates.filter(({ sites }) => sites.some(({ tier }) => tier === 'server')).map(({ key }) => key))
  const all = Object.keys(page.queries)
  const dependsOn = (candidate: ServerQuery) => candidate.deps.flatMap((dep) => dep === 'data.*' ? all
    : dep.startsWith('data.') ? [dep.slice(5)] : [])
  const eligible = new Set(candidates.map(({ key }) => key))
  for (const key of wanted) {
    const candidate = candidates.find((item) => item.key === key)!
    for (const dependency of dependsOn(candidate)) {
      if (eligible.has(dependency)) wanted.add(dependency)
    }
  }
  const ordered: ServerQuery[] = []
  const finished = new Set<string>()
  while (finished.size < wanted.size) {
    const ready = candidates.find((item) => wanted.has(item.key) && !finished.has(item.key) &&
      dependsOn(item).every((parent) => finished.has(parent)))
    if (!ready) break // A query still depending on client work must stay in the view.
    ordered.push(ready)
    finished.add(ready.key)
  }
  return ordered
}

export function printServerLoader(
  operation: ManifestOperation, kind: Query['kind'], name: string, sdk: string,
): string {
  const items = operation.kind === 'list' && operation.listItemsPath
  const rows = items ? 'value[' + JSON.stringify(items) + ']' : 'value'
  const total = operation.kind === 'list' && operation.pagination?.totalPath
  const payload = kind === 'list' ? '{ data: ' + rows + ', total: ' + (total ? 'value[' + JSON.stringify(total) + ']' : rows + '.length') + ' }'
    : '{ data: value }'
  return [
    'async function ' + name + '(options: NonNullable<Parameters<typeof ' + sdk + '>[0]>) {',
    '  const value = apiData(await ' + sdk + '(options))',
    '  return ' + payload,
    '}',
  ].join('\n')
}

export function printServerQueries(
  descriptors: readonly ServerQuery[], context: CompileContext, expression: (pointer: string) => string,
): { imports: ImportIR[]; preamble: string[]; declarations: string[] } {
  if (!descriptors.length) return { imports: [], preamble: [], declarations: [] }
  const source = context.contract?.modules.sdk?.importPath
  if (!source) throw new CompileError('invalid_result', 'Server queries require the generated SDK.')
  const { style } = context.facts
  const imports: ImportIR[] = [
    { name: 'apiRequest', source: '@/server/api' },
    { name: 'apiData', source: '@/server/api' },
  ]
  const preamble: string[] = []
  const declarations = [statement('const __bpApi = await apiRequest()', style)]
  const imported = new Map<string, string>()
  for (const { key, query, operation, name, loader } of descriptors) {
    const existing = imported.get(operation.sdkFn)
    const sdk = existing ?? '__bpSdk' + (imported.size + 1)
    if (existing === undefined) {
      imported.set(operation.sdkFn, sdk)
      imports.push({ name: operation.sdkFn, as: sdk, source })
    }
    preamble.push(printServerLoader(operation, query.kind, loader, sdk))
    const options = [...parameterOptions(key, query, operation, expression, style)]
    const call = 'await ' + loader + '({ ...__bpApi' + (options.length ? ', ' + options.join(', ') : '') + ' })'
    const value = query.enabled === undefined ? call
      : 'Boolean(' + expression(toPointer(['queries', key, 'enabled'])) + ') ? ' + call + ' : undefined'
    declarations.push(statement('const ' + name + ' = ' + value, style))
  }
  return { imports, preamble, declarations }
}

function parameterOptions(
  key: string, query: Query, operation: ManifestOperation, expression: (pointer: string) => string, style: ProjectFacts['style'],
): string[] {
  const groups = new Map<string, string[]>()
  const remaining = new Set(Object.keys(query.params))
  for (const parameter of operation.parameters) {
    const alias = parameter.in === 'path' && query.kind === 'one' && operation.kind === 'get' && operation.idParam === parameter.name
      ? 'id' : undefined
    const input = Object.hasOwn(query.params, parameter.name) ? parameter.name
      : alias && Object.hasOwn(query.params, alias) ? alias : undefined
    if (input === undefined) continue
    remaining.delete(input)
    const group = parameter.in === 'header' ? 'headers' : parameter.in
    const fields = groups.get(group) ?? []
    fields.push(property(parameter.name, style) + ': ' + expression(toPointer(['queries', key, 'params', input])))
    groups.set(group, fields)
  }
  if (remaining.size) {
    throw new CompileError('invalid_result', 'Server query ' + key + ' has no API parameter for ' + [...remaining].sort(compareBytes).join(', ') + '.')
  }
  return [...groups].map(([group, fields]) =>
    group + ': { ' + fields.join(', ') + (group === 'headers' ? ', ...__bpApi.headers' : '') + ' }')
}
