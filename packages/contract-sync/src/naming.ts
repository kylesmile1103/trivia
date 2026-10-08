// Resource naming. A resource name is PascalCase and singular ("Customer"), because binders
// derive identifiers from it (`customerData`, `isCustomerLoading`). English plurals can't be
// solved with a few rules; these cover common API nouns, and `x-trivia-resource` overrides them.

const IRREGULAR: Readonly<Record<string, string>> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  mice: 'mouse',
  geese: 'goose',
  teeth: 'tooth',
  feet: 'foot',
}

const UNCOUNTABLE = new Set([
  'news',
  'series',
  'species',
  'data',
  'metadata',
  'media',
  'information',
  'equipment',
  'feedback',
  'staff',
])

// -ies words whose singular keeps the "ie".
const IE_WORDS = new Set(['movies', 'cookies', 'pies', 'ties', 'lies', 'zombies', 'calories', 'hoodies'])

export function singularize(word: string): string {
  const lower = word.toLowerCase()
  const keepCase = (singular: string): string => word.slice(0, 1) + singular.slice(1)
  if (IRREGULAR[lower] !== undefined) return keepCase(IRREGULAR[lower])
  if (UNCOUNTABLE.has(lower)) return word
  if (/(ss|us|is)$/.test(lower)) return word
  if (lower.endsWith('ies') && lower.length > 4) {
    return IE_WORDS.has(lower) ? word.slice(0, -1) : `${word.slice(0, -3)}y`
  }
  if (/(sses|xes|shes|tches)$/.test(lower) || (lower.endsWith('uses') && !/(ouses|auses)$/.test(lower))) {
    return word.slice(0, -2)
  }
  if (lower.endsWith('s') && lower.length > 1) return word.slice(0, -1)
  return word
}

/** Splits on non-alphanumerics and camelCase boundaries: "customer-accounts" → ["customer", "accounts"]. */
export function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
}

export function pascalCase(parts: readonly string[]): string {
  return parts.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase()).join('')
}

/** PascalCase singular name from a tag, path segment or schema name. Leading digits are dropped. */
export function resourceNameFrom(key: string): string {
  const parts = words(key)
  const last = parts.pop()
  if (last === undefined) return ''
  parts.push(singularize(last))
  return pascalCase(parts).replace(/^[0-9]+/, '')
}

const SCHEMA_SUFFIX = /(Dto|DTO|Model|Entity|Resource|Response|Schema|Record|Read|View)$/

/** "CustomerDto" → "Customer", "CustomerResponseDto" → "Customer"; never strips to nothing. */
export function resourceNameFromSchema(schemaName: string): string {
  let name = schemaName
  for (let stripped = name.replace(SCHEMA_SUFFIX, ''); stripped.length > 0 && stripped !== name; ) {
    name = stripped
    stripped = name.replace(SCHEMA_SUFFIX, '')
  }
  return resourceNameFrom(name)
}
