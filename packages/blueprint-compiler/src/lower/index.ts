import { resolveManifests, type CustomPage, type ResolvedManifest } from '@trivia/blueprint'

import { CompileError, type CompileContext, type EmittedModule, type RegistryItem } from '../compile.js'
import type { ImportIR, PageIR } from '../ir.js'
import { printModule } from '../print/module.js'
import { compareBytes } from '../print/style.js'
import { refineName, relativeModule } from '../targets/vite-refine/files.js'
import { lowerJsx } from './jsx.js'

const intrinsic = resolveManifests({ kit: [], components: [] }).manifests

export function lowerCustom(page: CustomPage, context: CompileContext): EmittedModule {
  if ([page.bindings, page.state, page.queries, page.actions, page.control].some((entries) => Object.keys(entries).length)) {
    throw new CompileError('unsupported', 'This custom page needs dynamic lowering.')
  }
  const { facts } = context
  const resource = context.contract?.resources.find(({ name }) => name === page.resource)
  const dir = resource ? refineName(resource) : page.resource ?? page.name
  const file = facts.pagesDir + '/' + dir + '/' + page.name + '.tsx'
  const imports: ImportIR[] = []
  const missing = new Map<string, RegistryItem>()
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
    imports.push({ name, source: module })
    client ||= manifest.client
    return name
  }

  const jsx = lowerJsx(page, manifestOf, component)
  const ir: PageIR = {
    name: page.name, file, route: page.route, client, imports, jsx,
    state: [], queries: [], mutations: [], hooks: [], handlers: [],
  }
  return {
    code: printModule(ir, facts), file, route: page.route, component: page.name,
    importPath: relativeModule('src/App.tsx', file),
    requires: [...missing.entries()].sort(([a], [b]) => compareBytes(a, b)).map(([, item]) => item),
  }
}
