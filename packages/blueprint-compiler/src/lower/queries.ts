import { toPointer, type CustomPage, type Query } from '@trivia/blueprint'
import type { ManifestListOperation, ManifestResource } from '@trivia/contract-sync'

import { CompileError, type CompileContext } from '../compile.js'
import type { PrintStyle } from '../facts.js'
import type { ImportIR, QueryIR } from '../ir.js'
import { compareBytes, property, quote } from '../print/style.js'
import { refineName } from '../targets/paths.js'
import type { RefineHookMap } from '../targets/target.js'
import { operationUrl } from './actions.js'
import type { Names } from './names.js'
import type { ExpressionAnalysis } from './scope.js'

interface QueryDefinition {
  key: string
  query: Query
  name: string
  resource: ManifestResource
  fields: Record<string, string>
}

const object = (entries: readonly string[]) => entries.length ? '{ ' + entries.join(', ') + ' }' : '{}'

export function prepareQueries(
  page: CustomPage,
  context: CompileContext,
  names: Names,
  analysis: readonly ExpressionAnalysis[],
  { queries: queryHooks, queryStatus, initialOptions }: RefineHookMap,
  provided?: ReadonlyMap<string, Record<string, string>>,
  initial?: ReadonlyMap<string, string>,
) {
  const { style } = context.facts
  const rename: Record<string, string> = {}
  const definitions = new Map<string, QueryDefinition>()
  const imports: ImportIR[] = []
  for (const [key, query] of Object.entries(page.queries).sort(([a], [b]) => compareBytes(a, b))) {
    const resource = context.contract?.resources.find(({ name }) => name === query.resource)
    if (!resource) throw new CompileError('invalid_result', 'No contract resource named ' + query.resource)
    const name = names.take(key + 'Query')
    const hooks = queryHooks[query.kind]
    const fields: Record<string, string> = {}
    const direct = provided?.get(key)
    if (direct) Object.assign(fields, direct)
    else {
      for (const [field, path] of Object.entries({ ...hooks.fields, isLoading: queryStatus.isLoading, error: queryStatus.error })) {
        const value = name + '.' + path
        fields[field] = field === 'total' ? '(' + value + ' ?? 0)' : value
      }
    }
    for (const [field, value] of Object.entries(fields)) rename['data.' + key + '.' + field] = value
    rename['data.' + key] = '(' + object(Object.entries(fields).map(([field, value]) => field + ': ' + value)) + ')'
    definitions.set(key, { key, query, name, resource, fields })
    if (!direct) imports.push({ name: hooks.hook, source: '@refinedev/core' })
  }
  rename['data'] = '(' + object([...definitions.keys()].map((key) => property(key, style) + ': ' + rename['data.' + key])) + ')'
  const order = dependencyOrder(definitions, analysis)
  const types = new Map<string, string>()

  function lower(expression: (pointer: string) => string): QueryIR[] {
    return order.filter(({ key }) => !provided?.has(key)).map(({ key, query, name, resource, fields }) => {
      const hook = queryHooks[query.kind].hook
      const path = ['queries', key]
      const params = new Map(Object.keys(query.params).sort(compareBytes)
        .map((param) => [param, expression(toPointer([...path, 'params', param]))]))
      const args = query.kind === 'custom' ? customArguments(resource, query.operation, params, style)
        : ['resource: ' + quote(refineName(resource), style)]
      if (query.kind === 'list') {
        if (!resource.operations.list) throw new CompileError('invalid_result', resource.name + ' has no list operation')
        args.push(...listArguments(resource.operations.list, params, style))
      }
      if (query.kind === 'one') {
        const operation = resource.operations.get
        if (!operation) throw new CompileError('invalid_result', resource.name + ' has no get operation')
        const id = params.get(operation.idParam) ?? params.get('id')
        params.delete(operation.idParam)
        params.delete('id')
        if (id !== undefined) args.push('id: ' + id)
        if (params.size) args.push('meta: { query: ' + object(properties(params, style)) + ' }')
      }
      const seeded = initial?.get(key)
      const options = seeded ? initialOptions?.(seeded) ?? [] : []
      if (query.enabled !== undefined) options.unshift('enabled: ' + expression(toPointer([...path, 'enabled'])))
      if (options.length) args.push('queryOptions: ' + object(options))

      const typeName = query.kind === 'custom' ? undefined : resource.entity?.typeName
      const source = context.contract?.modules.types?.importPath
      let type: string | undefined
      if (typeName && source) {
        type = types.get(typeName)
        if (!type) {
          type = names.take(typeName)
          types.set(typeName, type)
          imports.push({ kind: 'type', source, name: typeName, ...(type !== typeName && { as: type }) })
        }
      }
      return { name, hook, fields, args: object(args), ...(type && { type }) }
    })
  }

  return { definitions, imports, rename, lower }
}

function dependencyOrder(
  definitions: ReadonlyMap<string, QueryDefinition>, analysis: readonly ExpressionAnalysis[],
): QueryDefinition[] {
  const needs = new Map([...definitions.keys()].map((key) => [key, new Set<string>()]))
  for (const { id, deps } of analysis) {
    const [, root, key] = id.split('/')
    if (root !== 'queries' || !key) continue
    const parents = needs.get(key)!
    for (const dep of deps) {
      if (dep === 'data.*') {
        for (const name of definitions.keys()) parents.add(name)
      } else if (dep.startsWith('data.') && definitions.has(dep.slice(5))) {
        parents.add(dep.slice(5))
      }
    }
  }
  const dependents = new Map<string, string[]>()
  const ready: string[] = []
  for (const [name, parents] of needs) {
    if (!parents.size) ready.push(name)
    for (const parent of parents) {
      const children = dependents.get(parent) ?? []
      children.push(name)
      dependents.set(parent, children)
    }
  }
  for (let i = 0; i < ready.length; i++) {
    const finished = ready[i]!
    for (const child of dependents.get(finished) ?? []) {
      const parents = needs.get(child)!
      parents.delete(finished)
      if (!parents.size) ready.push(child)
    }
  }
  if (ready.length !== definitions.size) throw new CompileError('invalid_result', 'Queries contain a dependency cycle')
  return ready.map((name) => definitions.get(name)!)
}

function properties(params: ReadonlyMap<string, string>, style: PrintStyle): string[] {
  return [...params].map(([key, value]) => property(key, style) + ': ' + value)
}

function listArguments(operation: ManifestListOperation, params: Map<string, string>, style: PrintStyle): string[] {
  const take = (name: string) => {
    const value = params.get(name)
    params.delete(name)
    return value
  }
  const page = take(operation.pagination?.pageParam ?? 'page') ?? take('currentPage')
  const size = take(operation.pagination?.pageSizeParam ?? 'pageSize')
  const pagination = take('pagination')
  const fields = [...(page === undefined ? [] : ['currentPage: ' + page]), ...(size === undefined ? [] : ['pageSize: ' + size])]
  const args: string[] = []
  if (pagination || fields.length) args.push('pagination: ' + (pagination ?? object(fields)))
  const sorters = take('sorters')
  const sort = take('sort')
  const order = take('order')
  if (sorters) args.push('sorters: ' + sorters)
  else if (sort) args.push('sorters: [{ field: ' + sort + ', order: ' + (order ?? quote('asc', style)) + ' }]')
  const filters = take('filters')
  const entries = [...params].map(([key, value]) => {
    const [, field, suffix] = /^(.+?)_(like|gte|lte)$/.exec(key) ?? []
    const operator = suffix === 'like' ? 'contains' : suffix ?? 'eq'
    return '{ field: ' + quote(field ?? key, style) + ', operator: ' + quote(operator, style) + ', value: ' + value + ' }'
  })
  if (filters) entries.unshift('...(' + filters + ')')
  if (entries.length) args.push('filters: [' + entries.join(', ') + ']')
  return args
}

function customArguments(resource: ManifestResource, name: string, params: Map<string, string>, style: PrintStyle): string[] {
  const operation = resource.customOperations.find((candidate) => [candidate.operationId, candidate.sdkFn].includes(name))
  if (!operation || !['GET', 'DELETE', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH'].includes(operation.method)) {
    throw new CompileError('invalid_result', 'No supported custom query ' + name + ' on ' + resource.name)
  }
  const url = operationUrl(operation.path, (key) => {
    const value = params.get(key)
    if (!value) throw new CompileError('invalid_result', name + ' requires a path parameter named ' + key)
    params.delete(key)
    return value
  }, style)
  const args = ['url: ' + url, 'method: ' + quote(operation.method.toLowerCase(), style)]
  const config: string[] = []
  const headers = new Map<string, string>()
  for (const parameter of operation.parameters) {
    const value = params.get(parameter.name)
    if (parameter.in === 'header' && value !== undefined) {
      headers.set(parameter.name, value)
      params.delete(parameter.name)
    }
  }
  if (headers.size) config.push('headers: ' + object(properties(headers, style)))
  const payload = params.get('payload')
  if (payload !== undefined) config.push('payload: ' + payload)
  params.delete('payload')
  if (params.size) config.push('query: ' + object(properties(params, style)))
  if (config.length) args.push('config: ' + object(config))
  return args
}
