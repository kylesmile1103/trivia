import { exposedScope, resolveManifests, toPointer, type ActionStep, type CustomPage, type ResolvedManifest } from '@trivia/blueprint'

import { CompileError, type CompileContext, type EmittedModule, type RegistryItem } from '../compile.js'
import type { AttributeIR, HandlerIR, ImportIR, PageIR, StateIR, StepIR } from '../ir.js'
import { printHandler, printModule } from '../print/module.js'
import { compareBytes, literal, property, quote, statement } from '../print/style.js'
import { refineName, relativeModule } from '../targets/vite-refine/files.js'
import { actionLowerer, capitalize, handlerStub } from './actions.js'
import { lowerJsx, type RepeatLocal } from './jsx.js'
import { Names } from './names.js'
import { prepareQueries } from './queries.js'
import { analyzePageExpressions, emitPageExpressions, routeScope } from './scope.js'

const intrinsic = resolveManifests({ kit: [], components: [] }).manifests

export function lowerCustom(page: CustomPage, context: CompileContext): EmittedModule {
  const { facts } = context
  const resource = context.contract?.resources.find(({ name }) => name === page.resource)
  const dir = resource ? refineName(resource) : page.resource ?? page.name
  const file = facts.pagesDir + '/' + dir + '/' + page.name + '.tsx'
  const imports: ImportIR[] = []
  const missing = new Map<string, RegistryItem>()
  const names = new Names([
    page.name, 'useState', 'event', 'value', 'useList', 'useOne', 'useCustom', 'useParams', 'useSearchParams', 'useGetIdentity',
    'useCreate', 'useUpdate', 'useDelete', 'useCustomMutation', 'useGo', 'useNotification',
  ])
  const identifiers = new Map<string, string>()
  let client = false

  const manifestOf = (type: string): ResolvedManifest => {
    const manifest = context.manifests?.[type] ?? intrinsic[type]
    if ((!manifest || manifest.type !== type) && type === 'Popover') {
      return {
        type, installed: false, client: true, props: [], slots: [], events: [], exposes: [], template: {},
        source: { registry: 'shadcn', item: 'popover', import: { name: type, from: 'ui' } },
      }
    }
    if (!manifest || manifest.type !== type) throw new CompileError('invalid_result', 'No component manifest for ' + type)
    if (manifest.composite) throw new CompileError('unsupported', manifest.type + ' requires the component kit.')
    return manifest
  }
  const component = (manifest: ResolvedManifest, part?: string): string => {
    const { source, installed } = manifest
    const { registry, item } = source
    const { from } = source.import
    const name = part ?? source.import.name
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
  const actions = Object.entries(page.actions).sort(([a], [b]) => compareBytes(a, b))
  const steps = actions.flatMap(([, items]) => items)
  const followsCall = steps.some((step) => step.do === 'call')
  const assigned = new Set(steps.flatMap((step) => step.do === 'setState' ? [step.name] : []))
  const byNode = new Map<string, Array<{ key: string; event: string; steps: ActionStep[] }>>()
  for (const [key, steps] of actions) {
    const [id, event] = key.split('.')
    const events = byNode.get(id!) ?? []
    events.push({ key, event: event!, steps })
    byNode.set(id!, events)
  }
  const state: StateIR[] = []
  const rename: Record<string, string> = {}
  const stateObject: string[] = []
  const setterObject: string[] = []
  const setters = new Map<string, string>()
  for (const [key, entry] of Object.entries(page.state).sort(([a], [b]) => compareBytes(a, b))) {
    const read = followsCall || deps.has('state.' + key) || deps.has('state.*')
    const write = followsCall || assigned.has(key)
    if (!read && !write) continue
    const name = names.take(key)
    rename['state.' + key] = name
    if (read) stateObject.push(name === key ? name : property(key, facts.style) + ': ' + name)
    const setter = write ? names.take('set' + capitalize(name)) : undefined
    if (setter) {
      setters.set(key, setter)
      setterObject.push(property(key, facts.style) + ': ' + setter)
    }
    state.push({ ...(read && { name }), ...(setter && { setter }), type: entry.type, initial: literal(entry.initial, facts.style) })
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
      const seed = props && Object.hasOwn(props, via.valueProp) ? props[via.valueProp] : initial
      let seedCode = literal(seed, facts.style)
      if (manifest.type === 'DatePicker' && manifest.source.registry === 'shadcn') {
        if (seed !== null && (typeof seed !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(seed) ||
          !Number.isFinite(Date.parse(seed)) || new Date(seed).toISOString().slice(0, 10) !== seed)) {
          throw new CompileError('invalid_result', node.name + '.' + via.valueProp + ' expects an ISO calendar date.')
        }
        seedCode = seed === null ? 'undefined' : 'new Date(' + literal(seed + 'T00:00:00', facts.style) + ')'
      }
      state.push({ name, setter, type, initial: seedCode })
      return { valueProp: via.valueProp, changeProp: via.changeProp, name, update: setter, arg: via.changeArg }
    })
    exposed.set(id, values)
  }
  if (state.length) imports.push({ name: 'useState', source: 'react' })
  const route = routeScope(deps, names)
  const query = prepareQueries(page, context, names, analysis)
  const repeats = new Map<string, RepeatLocal>()
  const byExpression = new Map<string, RepeatLocal>()
  for (const [id, control] of Object.entries(page.control).sort(([a], [b]) => compareBytes(a, b))) {
    if (!('each' in control)) continue
    const repeat: RepeatLocal = {
      alias: control.as,
      item: names.take('_' + control.as),
      ...(control.as !== 'index' && { index: names.take('_index') }),
    }
    repeats.set(id, repeat)
    byExpression.set(toPointer(['control', id, 'each']), repeat)
  }
  const localAliases = actions.length ? { event: '_event', value: '_value' } : {}
  const expression = emitPageExpressions(page, context.engine, { ...rename, ...route.rename, ...query.rename, ...localAliases },
    ui, new Set(actions.length ? ['event', 'value'] : []), ({ locals }) => Object.fromEntries(
      Object.entries(locals ?? {}).flatMap(([local, tier]) => {
        const repeat = typeof tier === 'object' ? byExpression.get(tier.from) : undefined
        return repeat ? [[local, local === repeat.alias ? repeat.item : repeat.index!]] : []
      }),
    ))
  const queries = query.lower(expression)
  imports.push(...route.imports, ...query.imports)
  const handlers: HandlerIR[] = []
  const renderObject = (fields: string[]) => fields.length ? '{ ' + fields.join(', ') + ' }' : '{}'
  const action = actionLowerer({
    contract: context.contract, page: page.name, file, style: facts.style, expression,
    name: (preferred) => names.take(preferred),
    setter: (key) => setters.get(key),
    query: (key) => query.definitions.get(key)?.name,
    state: renderObject(stateObject),
    setters: renderObject(setterObject),
  })

  const wire = (id: string, tag: string, attributes: Map<string, AttributeIR['value']>, repeated: boolean): void => {
    const changes = new Map<string, { arg: string; updates: Array<{ setter: string; value: string }> }>()
    for (const value of exposed.get(id) ?? []) {
      if (attributes.get(value.valueProp)?.kind !== 'expr') {
        attributes.set(value.valueProp, { kind: 'expr', code: value.name })
      }
      const change = changes.get(value.changeProp) ?? { arg: value.arg.startsWith('value') ? 'value' : 'event', updates: [] }
      change.updates.push({ setter: value.update, value: value.arg })
      changes.set(value.changeProp, change)
    }
    const changeSteps = (prop: string, event: string): StepIR[] =>
      (changes.get(prop)?.updates ?? []).map(({ setter, value }) => ({ code: setter + '(' + value.replace(/^(event|value)/, event) + ')' }))
    const node = page.nodes[id]!
    const manifest = manifestOf(node.type)
    for (const binding of byNode.get(id) ?? []) {
      const event = manifest.events.find(({ name }) => name === binding.event)
      if (!event) throw new CompileError('invalid_result', manifest.type + ' has no event ' + binding.event)
      const name = names.take('handle' + capitalize(node.name) + capitalize(binding.event))
      const react = 'import(' + quote('react', facts.style) + ')'
      const componentType = manifest.source.import.from ? 'typeof ' + tag : quote(tag, facts.style)
      const type = event.payload?.replace(/\bReact\./g, react + '.') ??
        'Parameters<NonNullable<' + react + '.ComponentProps<' + componentType + '>[' + quote(event.prop, facts.style) + ']>>[0]'
      const change = changes.get(event.prop)
      const value = (change?.updates[0]?.value ?? 'event').replace(/^(event|value)/, '_event')
      const handler: HandlerIR = {
        name, params: ['_event: ' + type, '_value = ' + value],
        body: [...changeSteps(event.prop, '_event'), ...action.steps(binding.steps, ['actions', binding.key])],
      }
      const callee = repeated ? '(' + printHandler(handler, facts.style) + ')' : name
      if (!repeated) handlers.push(handler)
      attributes.set(event.prop, { kind: 'expr', code: '(event) => void ' + callee + '(event).catch(console.error)' })
      changes.delete(event.prop)
    }
    for (const [prop, { arg }] of changes) {
      const steps = changeSteps(prop, arg).map(({ code }) => code)
      const body = steps.length === 1 ? steps[0] : '{\n' + steps.map((step) => statement(step, facts.style)).join('\n') + '\n}'
      attributes.set(prop, { kind: 'expr', code: '(' + arg + ') => ' + body })
    }
  }

  const jsx = lowerJsx(page, manifestOf, component, expression, wire, repeats, facts.style)
  const hooks = [...action.hooks.values()]
  const rank = (hook: string) => hook === 'useNotification' ? 2 : hook === 'useGo' ? 1 : 0
  hooks.sort((a, b) => rank(a.hook) - rank(b.hook))
  imports.push(...action.imports)
  const handler = handlerStub(page.name, action.calls.keys(), page.state, facts.style)
  const ir: PageIR = {
    name: page.name, file, route: page.route, client: client || state.length > 0 || actions.length > 0 || analysis.some(({ tier }) => tier === 'client'),
    imports, jsx, state, queries, mutations: hooks, hooks: route.hooks, handlers,
  }
  return {
    code: printModule(ir, facts), file, route: page.route, component: page.name,
    importPath: relativeModule('src/App.tsx', file),
    ...(handler && { handler }),
    requires: [...missing.entries()].sort(([a], [b]) => compareBytes(a, b)).map(([, item]) => item),
  }
}
