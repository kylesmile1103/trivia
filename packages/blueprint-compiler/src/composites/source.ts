import ts from 'typescript'

import type { ResolvedManifest } from '@trivia/blueprint'
import type { ManifestResource } from '@trivia/contract-sync'

import type { CompileContext } from '../compile.js'
import type { RefineSnippetImport } from '../contract-pages.js'
import type { ImportIR, JsxIR } from '../ir.js'

export interface CompositeScope {
  context: CompileContext
  name(preferred: string): string
  import(spec: ImportIR): string
  component(manifest: ResolvedManifest): string
  declarations: string[]
}

type Element = Extract<JsxIR, { kind: 'element' }>

export function indent(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return text.split('\n').map((line) => line ? prefix + line : '').join('\n')
}

/** Preserve the builder's source, adjusting identifiers only when page bindings require aliases. */
export function snippet(
  source: string, imports: RefineSnippetImport[], scope: CompositeScope, locals: Record<string, string> = {},
): string {
  const names = new Map(Object.entries(locals))
  for (const spec of imports) names.set(spec.name, scope.import(spec))
  if (![...names].some(([name, local]) => name !== local)) return source
  // A wrapper lets TypeScript read both a column object literal and a JSX control.
  const wrapped = '(' + source + ')'
  const syntax = ts.createSourceFile('snippet.tsx', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits: Array<{ start: number; end: number; text: string }> = []
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      const local = names.get(node.text)
      if (local && local !== node.text) edits.push({ start: node.getStart(syntax) - 1, end: node.end - 1, text: local })
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  let result = source
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  return result
}

/** Configuration belongs to the blueprint; className and key can live on an outer DOM element. */
export function withNodeAttributes(root: Element, content: Element): Element {
  const props = root.props.filter(({ name }) => name === 'className' || name === 'key')
  return props.length ? { kind: 'element', tag: 'div', props, children: [content] } : content
}


export function resourceRowType(resource: ManifestResource, scope: CompositeScope): string {
  const name = resource.entity?.typeName
  const source = scope.context.contract?.modules.types?.importPath
  return name && source ? scope.import({ name, source, kind: 'type' })
    : scope.import({ name: 'BaseRecord', source: '@refinedev/core', kind: 'type' })
}
