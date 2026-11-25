import ts from 'typescript'

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

/** Adopt the project's style on fresh scaffold output, preserving JSX text and expressions. */
export function restyleModule(code: string, style: PrintStyle): string {
  if (style.quotes === 'double' && style.semicolons) return code
  const ast = ts.createSourceFile('page.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits = new Map<number, { end: number; text: string }>()
  function visit(node: ts.Node): void {
    if (style.quotes === 'single' && ts.isStringLiteral(node)) {
      const start = node.getStart(ast)
      if (code[start] === '"') {
        const text = ts.isJsxAttribute(node.parent)
          ? "'" + code.slice(start + 1, node.end - 1).replaceAll("'", '&apos;') + "'"
          : quote(node.text, style)
        edits.set(start, { end: node.end, text })
      }
    }
    if (!style.semicolons && ts.isStatement(node) && node.kind !== ts.SyntaxKind.EmptyStatement && code[node.end - 1] === ';') {
      edits.set(node.end - 1, { end: node.end, text: '' })
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  let result = ''
  let cursor = 0
  for (const [start, { end, text }] of [...edits].sort(([a], [b]) => a - b)) {
    result += code.slice(cursor, start) + text
    cursor = end
  }
  return result + code.slice(cursor)
}

export function moduleImports(code: string): string[] {
  const ast = ts.createSourceFile('page.tsx', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  return ast.statements.flatMap((node) => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
    ? [node.moduleSpecifier.text] : [])
}
