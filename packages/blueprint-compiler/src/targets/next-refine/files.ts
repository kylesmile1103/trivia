import { CompileError, type EmittedModule, type PageSource } from '../../compile.js'
import type { ProjectFacts } from '../../facts.js'
import { printModule } from '../../print/module.js'
import { quote, restyleModule, statement } from '../../print/style.js'
import type { LoweredPage } from '../target.js'

export function nextPageFile(route: string, facts: ProjectFacts, file = 'page.tsx'): string {
  const folders = route.split('/').slice(1).filter(Boolean).map((segment) => {
    if (segment === '.' || segment === '..') throw new CompileError('invalid_result', 'Next.js routes cannot contain dot segments.')
    if (segment.startsWith(':')) return '[' + segment.slice(1) + ']'
    return segment.startsWith('_') ? '%5F' + segment.slice(1) : segment
  })
  return [facts.pagesDir, ...folders, file].join('/')
}

export function files(lowered: LoweredPage, facts: ProjectFacts): [EmittedModule, ...PageSource[]] {
  if (lowered.kind === 'contract') {
    const { page: { route }, generated: { component, content, handler } } = lowered
    return withView({ ...entry(route, facts), ...(handler && { handler }) }, component, content, facts)
  }
  const { ir, handler, requires } = lowered
  const page = { ...entry(ir.route, facts), requires, ...(handler && { handler }) }
  const content = printModule(ir, facts)
  if (ir.client || ir.hooks.length || ir.queries.length) return withView(page, ir.name, content, facts)
  return [{ ...page, component: ir.name, code: content.replace('export function ' + ir.name, 'export default function ' + ir.name) }]
}

function entry(route: string, facts: ProjectFacts): EmittedModule {
  const file = nextPageFile(route, facts)
  return { file, code: '', route, component: 'Page', importPath: file.slice(0, -4), requires: [] }
}

function withView(page: EmittedModule, component: string, content: string, facts: ProjectFacts): [EmittedModule, PageSource] {
  const { style } = facts
  const code = [
    statement('import { ' + component + ' as View } from ' + quote('./view', style), style), '',
    'export default function Page() {',
    '  ' + statement('return <View />', style),
    '}', '',
  ].join('\n')
  const view = statement(quote('use client', style), style) + '\n\n' + restyleModule(content, style)
  return [{ ...page, code }, { file: nextPageFile(page.route, facts, 'view.tsx'), code: view }]
}
