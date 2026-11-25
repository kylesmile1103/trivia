import { exposedScope, expressionRequest, pageDocPath, type CustomPage, type Diagnostic } from '@trivia/blueprint'
import ts from 'typescript'

import type { CompileContext } from '../../compile.js'
import { analyzePageExpressions } from '../../lower/scope.js'
import { compareBytes } from '../../print/style.js'
import { planBoundaries } from './boundaries.js'
import { serverQueries } from './server-data.js'

export const expressionOwner = (pointer: string) => {
  const [, group, key] = pointer.split('/')
  return group === 'bindings' || group === 'control' ? key : group === 'actions' ? key?.split('.')[0] : undefined
}

const queryName = (pointer: string) => pointer.startsWith('/queries/') ? pointer.split('/')[2] : undefined

function isFunction(value: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(value)) return isFunction(value.expression)
  if (ts.isConditionalExpression(value)) return isFunction(value.whenTrue) || isFunction(value.whenFalse)
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return true
  return ts.isPropertyAccessExpression(value) && ts.isPropertyAccessExpression(value.expression) &&
    value.expression.getText() === 'user.roles' && /^(map|filter|sort|find|some|every|join|slice|toString)$/.test(value.name.text)
}

export function boundaryFacts(page: CustomPage, context: Pick<CompileContext, 'engine' | 'manifests' | 'contract'>) {
  const ui = exposedScope(page, context.manifests ?? {})
  const analysis = analyzePageExpressions(page, context.engine, ui)
  const server = serverQueries(page, analysis, context.contract)
  const serverNames = new Set(server.map(({ key }) => key))
  const request = new Map(expressionRequest(page, ui).expressions.map((entry) => [entry.id, entry]))
  const nodes = Object.entries(page.nodes).sort(([left], [right]) => compareBytes(left, right))
  const byName = new Map(nodes.map(([id, node]) => [node.name, id]))
  const connections = new Map(nodes.map(([id]) => [id, new Set<string>()]))
  const clients = new Set(nodes.filter(([, { type, name }]) =>
    context.manifests?.[type]?.client || Object.hasOwn(ui.members, name)).map(([id]) => id))
  const values = new Map<string, { pointer: string; serializable: boolean }[]>()
  const queryConsumers = new Set<string>()
  const dependencies = (id: string, keys: readonly string[], visited = new Set<string>()) => {
    const connected = connections.get(id)!
    for (const dep of keys) {
      if (dep.startsWith('state.')) {
        for (const key of dep === 'state.*' ? Object.keys(page.state) : [dep.slice(6)]) connected.add('state.' + key)
      } else if (dep.startsWith('ui.')) {
        for (const key of dep === 'ui.*' ? Object.keys(ui.members) : [dep.slice(3)]) {
          connected.add('ui.' + key)
          const producer = byName.get(key)
          if (producer !== undefined) {
            clients.add(producer)
            connections.get(producer)!.add('ui.' + key)
          }
        }
      } else if (dep.startsWith('data.')) {
        for (const key of dep === 'data.*' ? Object.keys(page.queries) : [dep.slice(5)]) {
          connected.add('data.' + key)
          queryConsumers.add(key)
          if (serverNames.has(key)) continue
          clients.add(id)
          if (visited.has(key)) continue
          visited.add(key)
          dependencies(id, analysis.filter(({ id }) => queryName(id) === key).flatMap(({ deps }) => deps), visited)
        }
      }
    }
  }
  for (const expression of analysis) {
    const id = expressionOwner(expression.id)
    if (!id || !connections.has(id)) continue
    if (expression.tier === 'client') clients.add(id)
    dependencies(id, expression.deps)
    const source = request.get(expression.id)
    if (expression.tier !== 'server' || !source || source.locals ||
      expression.deps.some((dep) => dep.startsWith('data.'))) continue
    const ast = ts.createSourceFile('expression.ts', '(' + source.source + ')', ts.ScriptTarget.Latest, true)
    const statement = ast.statements[0]
    if (statement && ts.isExpressionStatement(statement)) {
      const list = values.get(id) ?? []
      list.push({ pointer: expression.id, serializable: !isFunction(statement.expression) })
      values.set(id, list)
    }
  }
  for (const [event, steps] of Object.entries(page.actions)) {
    const id = event.split('.')[0]!
    clients.add(id)
    for (const step of steps) {
      if (step.do === 'setState') dependencies(id, ['state.' + step.name])
      if (step.do === 'call') {
        dependencies(id, ['state.*'])
        connections.get(id)!.add('handler.' + step.handler)
      }
      if (step.do === 'refetch') dependencies(id, ['data.' + step.query])
    }
  }
  for (const query of Object.keys(page.queries)) {
    if (!queryConsumers.has(query)) dependencies(page.root, ['data.' + query])
  }
  // Repeat aliases belong to the map closure. Keep a client node and its outer loop together.
  for (const id of [...clients]) {
    for (let at: string | null = id; at !== null; at = page.nodes[at]!.parent) {
      const control = page.control[at]
      if (control && 'each' in control) {
        clients.add(at)
        connections.get(id)!.add('repeat.' + at)
        connections.get(at)!.add('repeat.' + at)
      }
    }
  }
  const plan = planBoundaries(nodes.map(([id, node]) => ({
    id, parent: node.parent, client: clients.has(id),
    dependencies: [...connections.get(id)!].filter((key) => !key.startsWith('data.') || !serverNames.has(key.slice(5))),
    values: values.get(id) ?? [],
  })))
  const diagnostics: Diagnostic[] = plan.invalid.map(({ node, pointer }) => ({
    doc: pageDocPath(page.name), pointer, severity: 'error', code: 'boundary_not_serializable',
    message: 'The value on ' + page.nodes[node]!.name + ' cannot cross into a Next.js client component.',
  }))
  return { plan, analysis, connections, diagnostics, server }
}

export function pagePart(page: CustomPage, root: string, boundaries: ReadonlySet<string>, connections: ReturnType<typeof boundaryFacts>['connections']): CustomPage {
  const nodes = new Set<string>()
  const rendered = new Set<string>()
  const children = new Map<string, string[]>()
  for (const [id, { parent }] of Object.entries(page.nodes)) {
    if (parent === null) continue
    const list = children.get(parent) ?? []
    list.push(id)
    children.set(parent, list)
  }
  const collect = (id: string) => {
    nodes.add(id)
    if (boundaries.has(id)) return
    rendered.add(id)
    for (const child of children.get(id) ?? []) collect(child)
  }
  collect(root)
  const query = new Set([...rendered].flatMap((id) => [...connections.get(id)!])
    .filter((dep) => dep.startsWith('data.')).map((dep) => dep.slice(5)))
  const pick = <T>(record: Record<string, T>, keep: (key: string) => boolean): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => keep(key)))
  return {
    ...page, root, nodes: pick(page.nodes, (id) => nodes.has(id)),
    props: pick(page.props, (id) => rendered.has(id)), bindings: pick(page.bindings, (id) => rendered.has(id)),
    styles: pick(page.styles, (id) => rendered.has(id)), control: pick(page.control, (id) => rendered.has(id)),
    actions: pick(page.actions, (key) => rendered.has(key.split('.')[0]!)), queries: pick(page.queries, (key) => query.has(key)),
  }
}
