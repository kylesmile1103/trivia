import { exposedScope, type CustomPage, type LayerCheck } from '@trivia/blueprint'

import { CompileError, type CompileContext } from '../../compile.js'
import type { ImportIR, JsxIR, PageIR } from '../../ir.js'
import { lowerCustom } from '../../lower/index.js'
import { capitalize, handlerStub } from '../../lower/actions.js'
import { Names } from '../../lower/names.js'
import { emitPageExpressions } from '../../lower/scope.js'
import { compareBytes, statement } from '../../print/style.js'
import { relativeModule } from '../paths.js'
import type { LoweredCustomPage, RefineHookMap } from '../target.js'
import { nextPageFile } from './files.js'
import { boundaryFacts, expressionOwner, pagePart } from './partition.js'
import { printServerQueries, queryFields } from './server-data.js'

const request = {
  params: '__bpParams',
  search: '__bpSearch',
  user: '__bpUser',
}

export function nextBoundaryCheck(context: Pick<CompileContext, 'engine' | 'manifests' | 'contract'>): LayerCheck {
  return (blueprint) => Object.values(blueprint.docs).flatMap((entry) =>
    entry.kind === 'page' && entry.doc?.kind === 'custom' ? boundaryFacts(entry.doc, context).diagnostics : [])
}

export function lowerNextCustom(page: CustomPage, context: CompileContext, hooks: RefineHookMap): LoweredCustomPage {
  const { plan, analysis, connections, diagnostics, server } = boundaryFacts(page, context)
  if (diagnostics.length) throw new CompileError('invalid_result', 'Invalid Next.js page ' + page.name, { diagnostics })

  const { facts } = context
  const { style } = facts
  const file = nextPageFile(page.route, facts)
  const imports: ImportIR[] = []
  const replacements = new Map<string, JsxIR>()
  const names = new Names([page.name])
  const preamble: string[] = []
  const views: PageIR[] = []
  const items: LoweredCustomPage['requires'] = []
  const required = new Set<string>()
  const enabled = new Set(plan.roots)
  const ownsEntirePage = enabled.has(page.root)
  const readServer = (pointer: string) => {
    const checked = analysis.find(({ id }) => pointer === id)
    return (checked?.deps ?? []).flatMap((dep) => {
      const [root] = dep.split('.')
      if (root && Object.hasOwn(request, root)) {
        required.add(root)
        return [root as keyof typeof request]
      }
      return []
    })
  }
  const params = page.route.split('/').filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1) + ': string')
  const routeTypes = {
    params: '{ ' + params.join('; ') + ' }',
    search: 'Record<string, string | string[] | undefined>',
    user: '{ id: string | undefined; name: string | undefined; roles: string[] }',
  }
  const ui = exposedScope(page, context.manifests ?? {})
  const queryValues = new Map(server.map(({ key, query, name }) => [key, queryFields(query.kind, name)]))
  const aliases: Record<string, string> = { ...request }
  for (const [key, fields] of queryValues) {
    aliases['data.' + key] = '({ ' + Object.entries(fields).map(([name, value]) => name + ': ' + value).join(', ') + ' })'
    for (const [field, value] of Object.entries(fields)) aliases['data.' + key + '.' + field] = value
  }
  aliases['data'] = '({ ' + server.map(({ key }) => key + ': ' + aliases['data.' + key]).join(', ') + ' })'
  const expression = emitPageExpressions(page, context.engine, aliases, ui)
  const data = printServerQueries(page, server, context, expression)
  for (const { key } of server) {
    for (const { id } of analysis) if (id.startsWith('/queries/' + key + '/')) readServer(id)
  }
  imports.push(...data.imports)
  preamble.push(...data.preamble)
  for (const root of plan.roots) {
    const name = names.take(capitalize(page.nodes[root]!.name) + 'View')
    const view = nextPageFile(page.route, facts, plan.roots.length === 1 ? 'view.tsx' : 'view.' + page.nodes[root]!.name + '.tsx')
    const props = plan.crossings.filter((crossing) => crossing.boundary === root)
    const values = new Map(props.map(({ pointer }, index) => [pointer, '__bpValue' + (index + 1)]))
    const rootNeeds = new Set(props.flatMap(({ pointer }) => readServer(pointer)))
    const part = pagePart(page, root, new Set(), connections)
    const initial = server.filter(({ key }) => Object.hasOwn(part.queries, key))
    const initialQueries = new Map(initial.map(({ key, name }) => [key, name]))
    const lower = lowerCustom(part, context, hooks, { file: view, name, values, initialQueries })
    const { ir } = lower
    const spread: string[] = []
    if (values.size || initial.length) {
      const getter = 'get' + name + 'Props'
      const type = name + 'Props'
      const args = [...[...rootNeeds].map((root) => request[root] + ': ' + routeTypes[root]),
        ...initial.map(({ name, loader, query }) => name + ': Awaited<ReturnType<typeof ' + loader + '>>' +
          (query.enabled === undefined ? '' : ' | undefined'))].join(', ')
      const body = [...[...values].map(([pointer, key]) => '    ' + key + ': ' + expression(pointer) + ','),
        ...initial.map(({ name }) => '    ' + name + ',')]
      preamble.push(['function ' + getter + '(' + args + ') {', '  return {', ...body, '  }', '}'].join('\n'))
      preamble.push(statement('export type ' + type + ' = ReturnType<typeof ' + getter + '>', style))
      ir.imports.push({ kind: 'type', source: './page', name: type })
      ir.parameters = '{ ' + [...values.values(), ...initial.map(({ name }) => name)].join(', ') + ' }: ' + type
      spread.push(getter + '(' + [...[...rootNeeds].map((root) => request[root]), ...initial.map(({ name }) => name)].join(', ') + ')')
    }
    imports.push({ name, source: relativeModule(file, view) })
    replacements.set(root, { kind: 'element', tag: name, props: [], children: [], ...(spread.length && { spreads: spread }) })
    views.push(ir)
    items.push(...lower.requires)
  }
  let ir: PageIR
  if (ownsEntirePage) {
    ir = { name: page.name, file, route: page.route, client: false, imports: [], state: [], queries: [], hooks: [],
      mutations: [], handlers: [], jsx: replacements.get(page.root)! }
  } else {
    const part = pagePart(page, page.root, enabled, connections)
    const lower = lowerCustom(part, context, hooks, { file, name: page.name, replacements, routeValues: request, queryValues })
    ir = lower.ir
    items.push(...lower.requires)
    for (const site of analysis) {
      const owner = expressionOwner(site.id)
      if (owner && Object.hasOwn(part.nodes, owner) && !enabled.has(owner)) readServer(site.id)
    }
  }
  ir.imports.push(...imports)
  ir.defaultExport = true
  ir.preamble = preamble
  const routeProps: string[] = []
  const types: string[] = []
  const before: string[] = []
  if (required.has('params')) {
    routeProps.push('params')
    types.push('params: Promise<' + routeTypes.params + '>')
    before.push(statement('const ' + request.params + ' = await params', style))
  }
  if (required.has('search')) {
    routeProps.push('searchParams')
    types.push('searchParams: Promise<' + routeTypes.search + '>')
    before.push(statement('const ' + request.search + ' = await searchParams', style))
  }
  if (required.has('user')) {
    before.push(statement('const ' + request.user + ': ' + routeTypes.user + ' = { id: undefined, name: undefined, roles: [] }', style))
  }
  if (routeProps.length) {
    ir.async = true
    ir.parameters = '{ ' + routeProps.join(', ') + ' }: { ' + types.join('; ') + ' }'
  }
  ir.async ||= server.length > 0
  ir.afterState = [...before, ...data.declarations, ...(ir.afterState ?? [])]
  const calls = Object.values(page.actions).flatMap((steps) => steps.flatMap((step) => step.do === 'call' ? [step.handler] : []))
  const handler = handlerStub(page.name, calls, page.state, style)
  const requires = [...new Map(items.map((item) => [item.registry + '/' + item.item, item]))]
    .sort(([left], [right]) => compareBytes(left, right)).map(([, item]) => item)
  return { kind: 'custom', ir, views, requires, ...(handler && { handler }) }
}
