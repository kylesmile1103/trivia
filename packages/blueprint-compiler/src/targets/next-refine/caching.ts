import { pageDocPath, toPointer, type CustomPage, type Diagnostic } from '@trivia/blueprint'

import type { PrintStyle } from '../../facts.js'
import type { ExpressionAnalysis } from '../../lower/scope.js'
import { literal, statement } from '../../print/style.js'
import type { ServerQuery } from './server-data.js'

export function publicDataChecks(page: CustomPage, analysis: readonly ExpressionAnalysis[], queries: readonly ServerQuery[]): Diagnostic[] {
  if (!page.public) return []
  const serverQuery = new Set(queries.map(({ key }) => key))
  const pointers = new Set<string>()
  for (const site of analysis) {
    const [, group, name] = site.id.split('/')
    if (site.tier !== 'server' || !site.deps.some((dep) => dep.startsWith('user.'))) continue
    if (group === 'bindings' || group === 'control' || (group === 'queries' && name && serverQuery.has(name))) {
      pointers.add(site.id)
    }
  }
  for (const { key, query, operation } of queries) {
    for (const parameter of operation.parameters) {
      if (parameter.in === 'header' && /^(cookie|authorization)$/i.test(parameter.name) &&
        Object.hasOwn(query.params, parameter.name)) {
        pointers.add(toPointer(['queries', key, 'params', parameter.name]))
      }
    }
  }
  return [...pointers].map((pointer) => ({
    code: 'public_page_uses_user', doc: pageDocPath(page.name), pointer, severity: 'error',
    message: 'Public Next.js pages cannot use identity or credentials in server data.',
  }))
}

export function cachedFunction(name: string, source: string, key: readonly string[], style: PrintStyle): string {
  return statement('const ' + name + ' = unstable_cache(' + source + ', ' + literal(key, style) + ', { revalidate: 30 })', style)
}
