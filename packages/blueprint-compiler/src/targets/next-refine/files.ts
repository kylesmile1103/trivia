import { CompileError, type EmittedModule, type PageSource } from '../../compile.js'
import type { ProjectFacts } from '../../facts.js'
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
  if (lowered.kind !== 'contract') throw new CompileError('unsupported', 'Next.js custom pages require client boundary analysis.')
  const { page: { route }, generated } = lowered
  const { component, content, handler } = generated
  const file = nextPageFile(route, facts)
  const viewFile = nextPageFile(route, facts, 'view.tsx')
  const { style } = facts
  const code = [
    statement('import { ' + component + ' as View } from ' + quote('./view', style), style), '',
    'export default function Page() {',
    '  ' + statement('return <View />', style),
    '}', '',
  ].join('\n')
  const view = statement(quote('use client', style), style) + '\n\n' + restyleModule(content, style)
  return [{ file, code, route, component: 'Page', importPath: file.slice(0, -4), requires: [], ...(handler && { handler }) },
    { file: viewFile, code: view }]
}
