import type { ProjectFacts } from '../facts.js'
import type { ImportIR } from '../ir.js'
import { compareBytes, quote, statement } from './style.js'

export function printImports(imports: readonly ImportIR[], facts: ProjectFacts): string {
  const sources = new Map<string, ImportIR[]>()
  for (const spec of imports) {
    const group = sources.get(spec.source) ?? []
    group.push(spec)
    sources.set(spec.source, group)
  }

  const aliases = Object.values(facts.aliases)
  const sections: [string[], string[], string[]] = [[], [], []]
  for (const [source, specs] of [...sources].sort(([a], [b]) => compareBytes(a, b))) {
    const aliased = /^[@#~]\//.test(source) || aliases.some((alias) => source === alias || source.startsWith(alias + '/'))
    const out = sections[source.startsWith('.') ? 2 : aliased ? 1 : 0]
    const module = quote(source, facts.style)
    const names = (kind: ImportIR['kind']) => [...new Set(specs
      .filter((spec) => (spec.kind ?? 'named') === kind)
      .map(({ name, as }) => as && as !== name ? name + ' as ' + as : name))].sort(compareBytes)

    const types = names('type')
    const named = names('named')
    const defaults = [...new Set(specs.filter((spec) => spec.kind === 'default').map((spec) => spec.as ?? spec.name))].sort(compareBytes)

    if (types.length) out.push(statement('import type { ' + types.join(', ') + ' } from ' + module, facts.style))
    const primary = defaults.shift()
    const clause = [primary, named.length ? '{ ' + named.join(', ') + ' }' : undefined].filter(Boolean).join(', ')
    if (clause) out.push(statement('import ' + clause + ' from ' + module, facts.style))
    for (const local of defaults) out.push(statement('import ' + local + ' from ' + module, facts.style))
  }
  return sections.filter((items) => items.length > 0).map((items) => items.join('\n')).join('\n\n')
}
