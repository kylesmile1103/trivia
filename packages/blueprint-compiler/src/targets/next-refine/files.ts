import { CompileError, type EmittedModule, type PageSource } from '../../compile.js'
import type { ProjectFacts } from '../../facts.js'
import { printModule } from '../../print/module.js'
import { quote, restyleModule, statement } from '../../print/style.js'
import { printContractEntry, type ContractRecord } from './server-data.js'
import type { LoweredPage } from '../target.js'

export function nextPageFile(route: string, facts: ProjectFacts, file = 'page.tsx'): string {
  if (facts.previewDirectory) return facts.previewDirectory + '/' + file
  const folders = route.split('/').slice(1).filter(Boolean).map((segment) => {
    if (segment === '.' || segment === '..') throw new CompileError('invalid_result', 'Next.js routes cannot contain dot segments.')
    if (segment.startsWith(':')) return '[' + segment.slice(1) + ']'
    return segment.startsWith('_') ? '%5F' + segment.slice(1) : segment
  })
  return [facts.pagesDir, ...folders, file].join('/')
}

export function files(lowered: LoweredPage, facts: ProjectFacts): [EmittedModule, ...PageSource[]] {
  if (lowered.kind === 'contract') {
    const { page: { route }, generated: { component, content, handler, prefetch } } = lowered
    return withView({ ...entry(route, facts), ...(handler && { handler }) }, component, content, facts, prefetch)
  }
  const { ir, handler, requires, views = [] } = lowered
  const page = { ...entry(ir.route, facts), requires, ...(handler && { handler }) }
  const code = printModule(ir, facts)
  const siblings = views.map((view) => ({
    file: view.file, code: clientView(printModule(view, facts), facts),
  }))
  return [{ ...page, component: ir.name, code }, ...siblings]
}

function entry(route: string, facts: ProjectFacts): EmittedModule {
  const file = nextPageFile(route, facts)
  return { file, code: '', route, component: 'Page', importPath: file.slice(0, -4), requires: [] }
}

function withView(
  page: EmittedModule, component: string, content: string, facts: ProjectFacts, prefetch?: ContractRecord,
): [EmittedModule, PageSource] {
  const { style } = facts
  const code = prefetch ? printContractEntry(component, page.route, prefetch, facts) : [
    statement('import { ' + component + ' as View } from ' + quote('./view', style), style), '',
    'export default function Page() {',
    '  ' + statement('return <View />', style),
    '}', '',
  ].join('\n')
  return [{ ...page, code }, {
    file: nextPageFile(page.route, facts, 'view.tsx'), code: clientView(content, facts),
  }]
}

function clientView(content: string, { style }: ProjectFacts): string {
  return statement(quote('use client', style), style) + '\n\n' + restyleModule(content, style)
}
