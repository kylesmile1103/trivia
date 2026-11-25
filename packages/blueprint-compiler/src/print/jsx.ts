import type { PrintStyle } from '../facts.js'
import type { AttributeIR, JsxIR } from '../ir.js'
import { literal, quote } from './style.js'

const textEntities: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '{': '&#123;', '}': '&#125;',
}

export function jsxText(value: string, style: PrintStyle): string {
  if (value.trim() !== value || /[\r\n\t]/.test(value)) return '{' + quote(value, style) + '}'
  return value.replace(/[&<>{}]/g, (character) => textEntities[character]!)
}

function attribute({ name, value }: AttributeIR, style: PrintStyle): string {
  if (value.kind === 'expr') return name + '={' + value.code + '}'
  if (typeof value.value === 'string' && !/[\r\n\t]/.test(value.value)) {
    const delimiter = style.quotes === 'single' ? "'" : '"'
    const escaped = value.value.replace(/[&<>{}]/g, (character) => textEntities[character]!)
      .replaceAll(delimiter, delimiter === "'" ? '&apos;' : '&quot;')
    return name + '=' + delimiter + escaped + delimiter
  }
  return name + '={' + literal(value.value, style) + '}'
}

export function printJsx(node: JsxIR, level: number, style: PrintStyle, asChild = false): string {
  const at = '  '.repeat(level)
  switch (node.kind) {
    case 'source':
      return node.code.split('\n').map((line) => at + line).join('\n')
    case 'text':
      return at + jsxText(node.value, style)
    case 'expr':
      return at + (asChild ? '{' + node.code + '}' : node.code)
    case 'cond':
      return at + (asChild ? '{' : '') + 'Boolean(' + node.test + ') && (\n'
        + printJsx(node.child, level + 1, style) + '\n' + at + ')' + (asChild ? '}' : '')
    case 'repeat':
      return at + (asChild ? '{' : '') + '(' + node.list + ').map((' + [node.item, node.index].filter(Boolean).join(', ') + ') => (\n'
        + printJsx(node.child, level + 1, style) + '\n' + at + '))' + (asChild ? '}' : '')
    case 'element': {
      const attributes = [...(node.spreads ?? []).map((expression) => '{...' + expression + '}'), ...node.props.map((prop) => attribute(prop, style))]
      const end = node.children.length ? '>' : ' />'
      const compact = at + '<' + node.tag + (attributes.length ? ' ' + attributes.join(' ') : '') + end
      const opening = attributes.length && (compact.length > 100 || compact.includes('\n'))
        ? at + '<' + node.tag + '\n' + attributes.map((item) => at + '  ' + item).join('\n') + '\n' + at + end.trimStart()
        : compact
      if (!node.children.length) return opening
      const closing = '</' + node.tag + '>'
      const only = node.children.length === 1 ? node.children[0] : undefined
      if (only?.kind === 'text' || only?.kind === 'expr') {
        const inline = opening + printJsx(only, 0, style, true) + closing
        if (!inline.includes('\n') && inline.length <= 100) return inline
      }
      return opening + '\n' + node.children.map((child) => printJsx(child, level + 1, style, true)).join('\n') + '\n' + at + closing
    }
  }
}
