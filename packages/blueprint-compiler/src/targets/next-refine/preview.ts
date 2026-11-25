import type { EmittedModule, PageSource } from '../../compile.js'
import type { ProjectFacts } from '../../facts.js'
import { quote, statement } from '../../print/style.js'

export function nextPreview(page: string, facts?: ProjectFacts) {
  const app = facts?.pagesDir === 'src/app' || facts?.pagesDir.startsWith('src/app/') ? 'src/app' : 'app'
  return {
    id: page, route: '/__blueprint/' + page,
    directory: app + '/(blueprint-preview)/%5F_blueprint/' + page,
  }
}

export function nextPreviewFiles(module: EmittedModule, facts: ProjectFacts): PageSource[] {
  const { file, code, additional = [], handler } = module
  const directory = facts.previewDirectory!
  const supplemental = [...additional, ...(handler ? [{ file: directory + '/handler.ts', code: handler.code }] : [])]
  // A fixed preview URL receives dynamic segment values from its search parameters.
  const params = module.route.split('/').filter((segment) => segment.startsWith(':')).map((segment) => segment.slice(1))
  if (!params.length || !code.includes('await params')) return [{ file, code }, ...supplemental]
  const { style } = facts
  const compiled = './compiled'
  const entry = [
    statement('import Compiled from ' + quote(compiled, style), style),
    statement('export type * from ' + quote(compiled, style), style), '',
    'export default async function Preview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {',
    '  ' + statement('const search = await searchParams', style),
    '  ' + statement('const params = Promise.resolve({ ' + params.map((key) =>
      key + ': String(search[' + quote(key, style) + '] ?? ' + quote('', style) + ')').join(', ') + ' })', style),
    '  ' + statement('return <Compiled {...{ params, searchParams }} />', style),
    '}', '',
  ].join('\n')
  return [{ file, code: entry }, { file: directory + '/compiled.tsx', code }, ...supplemental]
}
