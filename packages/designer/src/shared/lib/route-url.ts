// Route patterns as the plugin reports them (docs/api.md `AppRoute.path`), in either router's
// syntax: React Router `:id`, `:id?`, `*`; TanStack Router `$id`, `{-$id}`, `$`. A splat's value
// is under `*`.

type Segment =
  | { kind: 'static'; text: string }
  | { kind: 'param'; name: string; optional: boolean }
  | { kind: 'splat' }

function segments(pattern: string): Segment[] {
  return pattern
    .split('/')
    .filter((s) => s !== '')
    .map((s): Segment => {
      if (s === '*' || s === '$') return { kind: 'splat' }
      const react = /^:([\w$-]+)(\?)?$/.exec(s)
      if (react) return { kind: 'param', name: react[1]!, optional: react[2] === '?' }
      const optional = /^\{-\$([\w-]+)\}$/.exec(s)
      if (optional) return { kind: 'param', name: optional[1]!, optional: true }
      const tanstack = /^\$([\w-]+)$/.exec(s)
      if (tanstack) return { kind: 'param', name: tanstack[1]!, optional: false }
      return { kind: 'static', text: s }
    })
}

/** The param values `pathname` gives `pattern` (a splat's under `*`), or null when it isn't that route. */
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const parts = segments(pattern)
  const names: string[] = []
  const source = parts
    .map((part) => {
      if (part.kind === 'static') return `/${part.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
      if (part.kind === 'splat') {
        names.push('*')
        return '(?:/(.*))?'
      }
      names.push(part.name)
      return part.optional ? '(?:/([^/]+))?' : '/([^/]+)'
    })
    .join('')
  const match = new RegExp(`^${source}/?$`).exec(pathname)
  if (!match) return null
  const values: Record<string, string> = {}
  names.forEach((name, i) => {
    const value = match[i + 1]
    if (value !== undefined) values[name] = decode(value)
    else if (name === '*') values[name] = ''
  })
  return values
}

/** The URL for `pattern` with `values` filled in; null while a required param is empty. */
export function fillRoute(pattern: string, values: Record<string, string>): string | null {
  const out: string[] = []
  for (const part of segments(pattern)) {
    if (part.kind === 'static') out.push(part.text)
    else if (part.kind === 'splat') {
      const rest = (values['*'] ?? '').trim().replace(/^\/+/, '')
      if (rest !== '') out.push(rest.split('/').map(encodeURIComponent).join('/'))
    } else {
      const value = (values[part.name] ?? '').trim()
      if (value !== '') out.push(encodeURIComponent(value))
      else if (!part.optional) return null
    }
  }
  return `/${out.join('/')}`
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
