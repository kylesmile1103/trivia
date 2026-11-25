import type { Blueprint } from '../store.js'
import type { Diagnostic } from '../types/diagnostics.js'

/** A Next route is a directory path and shares its dynamic folders with sibling routes. */
export function checkNextRoutes(blueprint: Blueprint): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const dynamic = new Map<string, string>()
  for (const [doc, entry] of Object.entries(blueprint.docs)) {
    if (entry.kind !== 'page' || entry.doc === null) continue
    const { route } = entry.doc
    const segments = route.slice(1).split('/')
    const names = new Set<string>()
    const candidate: Array<[string, string]> = []
    let prefix = ''
    let message: string | undefined
    for (const segment of segments) {
      if (segment === '.' || segment === '..') {
        message = 'Next.js routes cannot contain dot segments.'
        break
      }
      if (!segment.startsWith(':')) {
        prefix += '/' + segment
        continue
      }
      prefix += '/:'
      const previous = dynamic.get(prefix)
      if (names.has(segment)) {
        message = 'Next.js route ' + route + ' repeats the parameter ' + segment + '.'
        break
      }
      if (previous !== undefined && previous !== segment) {
        message = 'The dynamic folder at ' + prefix + ' already uses the parameter ' + previous + '.'
        break
      }
      names.add(segment)
      candidate.push([prefix, segment])
    }
    if (message) diagnostics.push({ code: 'invalid_next_route', severity: 'error', doc, pointer: '/route', message })
    else for (const [prefix, segment] of candidate) dynamic.set(prefix, segment)
  }
  return diagnostics
}
