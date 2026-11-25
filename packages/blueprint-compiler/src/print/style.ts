import type { PrintStyle } from '../facts.js'

export const compareBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))

export function statement(code: string, style: PrintStyle): string {
  return style.semicolons ? code + ';' : code
}

export function quote(text: string, style: PrintStyle): string {
  const json = JSON.stringify(text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  if (style.quotes === 'double') return json
  return "'" + json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'"
}

export function property(name: string, style: PrintStyle): string {
  if (name === '__proto__') return '[' + quote(name, style) + ']'
  return /^[a-zA-Z_$][\w$]*$/.test(name) ? name : quote(name, style)
}

export function literal(value: unknown, style: PrintStyle): string {
  if (typeof value === 'string') return quote(value, style)
  if (Array.isArray(value)) return '[' + value.map((item) => literal(item, style)).join(', ') + ']'
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => compareBytes(a, b))
    if (!entries.length) return '{}'
    return '{ ' + entries.map(([name, item]) => property(name, style) + ': ' + literal(item, style)).join(', ') + ' }'
  }
  return JSON.stringify(value) ?? 'undefined'
}
