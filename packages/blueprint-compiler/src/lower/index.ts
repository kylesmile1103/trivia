import { exposedScope, resolveManifests, type CustomPage, type ResolvedManifest } from '@trivia/blueprint'

import { CompileError, type CompileContext, type EmittedModule, type RegistryItem } from '../compile.js'
import type { AttributeIR, ImportIR, PageIR, StateIR } from '../ir.js'
import { printModule } from '../print/module.js'
import { compareBytes, literal, property, statement } from '../print/style.js'
import { refineName, relativeModule } from '../targets/vite-refine/files.js'
import { capitalize } from './actions.js'
import { lowerJsx } from './jsx.js'
import { Names } from './names.js'
import { analyzePageExpressions, emitPageExpressions } from './scope.js'

const intrinsic = resolveManifests({ kit: [], components: [] }).manifests

export function lowerCustom(page: CustomPage, context: CompileContext): EmittedModule {
  if ([page.queries, page.actions, page.control].some((entries) => Object.keys(entries).length)) {
    throw new CompileError('unsupported', 'This custom page needs query, action or control-flow lowering.')
  }
  const { facts } = context
  const resource = context.contract?.resources.find(({ name }) => name === page.resource)
  const dir = resource ? refineName(resource) : page.resource ?? page.name
  const file = facts.pagesDir + '/' + dir + '/' + page.name + '.tsx'
  const imports: ImportIR[] = []
  const missing = new Map<string, RegistryItem>()
  const names = new Names([page.name, 'useState', 'event', 'value'])
  const identifiers = new Map<string, string>()
  let client = false

  const manifestOf = (type: string): ResolvedManifest => {
    const manifest = context.manifests?.[type] ?? intrinsic[type]
    if (!manifest || manifest.type !== type) throw new CompileError('invalid_result', 'No component manifest for ' + type)
    if (manifest.composite) throw new CompileError('unsupported', manifest.type + ' requires the component kit.')
    return manifest
  }
  const component = (manifest: ResolvedManifest): string => {
    const { source, installed } = manifest
    const { registry, item } = source
    const { name, from } = source.import
    if (!from) return name
    if (!installed) missing.set(registry + '/' + item, { registry, item })
    const module = from === 'ui' ? facts.aliases['ui'] + '/' + item : from
    if (module.startsWith('@trivia/')) throw new CompileError('unsupported', 'Generated pages cannot import ' + module)
    const key = module + '\0' + name
    let identifier = identifiers.get(key)
    if (!identifier) {
      identifier = names.take(name)
      identifiers.set(key, identifier)
      imports.push({ name, source: module, ...(identifier !== name && { as: identifier }) })
    }
    client ||= manifest.client
    return identifier
  }

  const ui = exposedScope(page, context.manifests ?? {})
  const analysis = analyzePageExpressions(page, context.engine, ui)
  const deps = new Set(analysis.flatMap(({ deps }) => deps))
  const state: StateIR[] = []
  const rename: Record<string, string> = {}
  const stateObject: string[] = []
  for (const [key, entry] of Object.entries(page.state).sort(([a], [b]) => compareBytes(a, b))) {
    if (!deps.has('state.' + key) && !deps.has('state.*')) continue
    const name = names.take(key)
    rename['state.' + key] = name
    stateObject.push(property(key, facts.style) + ': ' + name)
    state.push({ name, type: entry.type, initial: literal(entry.initial, facts.style) })
  }
  if (deps.has('state.*')) rename['state'] = '({ ' + stateObject.join(', ') + ' })'

  const exposed = new Map<string, Array<{ valueProp: string; changeProp: string; name: string; update: string; arg: string }>>()
  for (const [id, node] of Object.entries(page.nodes).sort(([a], [b]) => compareBytes(a, b))) {
    const manifest = manifestOf(node.type)
    if (!manifest.exposes.length) continue
    const values = manifest.exposes.map(({ name: key, type, initial, via }) => {
      const name = names.take(node.name + capitalize(key))
      const setter = names.take('set' + capitalize(name))
      const props = page.props[id]
      rename['ui.' + node.name + '.' + key] = name
      state.push({
        name, setter, type, initial: literal(props && Object.hasOwn(props, via.valueProp) ? props[via.valueProp] : initial, facts.style),
      })
      return { valueProp: via.valueProp, changeProp: via.changeProp, name, update: setter, arg: via.changeArg }
    })
    exposed.set(id, values)
  }
  if (state.length) imports.push({ name: 'useState', source: 'react' })
  const expression = emitPageExpressions(page, context.engine, rename, ui)
  const wire = (id: string, attributes: Map<string, AttributeIR['value']>): void => {
    const changes = new Map<string, { arg: string; steps: string[] }>()
    for (const value of exposed.get(id) ?? []) {
      if (attributes.get(value.valueProp)?.kind !== 'expr') {
        attributes.set(value.valueProp, { kind: 'expr', code: value.name })
      }
      const change = changes.get(value.changeProp) ?? { arg: value.arg === 'value' ? 'value' : 'event', steps: [] }
      change.steps.push(value.update + '(' + value.arg.replace(/^(event|value)/, change.arg) + ')')
      changes.set(value.changeProp, change)
    }
    for (const [prop, { arg, steps }] of changes) {
      const body = steps.length === 1 ? steps[0] : '{\n' + steps.map((step) => statement(step, facts.style)).join('\n') + '\n}'
      attributes.set(prop, { kind: 'expr', code: '(' + arg + ') => ' + body })
    }
  }

  const jsx = lowerJsx(page, manifestOf, component, expression, wire)
  const ir: PageIR = {
    name: page.name, file, route: page.route, client: client || state.length > 0 || analysis.some(({ tier }) => tier === 'client'),
    imports, jsx, state, queries: [], mutations: [], hooks: [], handlers: [],
  }
  return {
    code: printModule(ir, facts), file, route: page.route, component: page.name,
    importPath: relativeModule('src/App.tsx', file),
    requires: [...missing.entries()].sort(([a], [b]) => compareBytes(a, b)).map(([, item]) => item),
  }
}
