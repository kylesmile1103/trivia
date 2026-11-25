import { toPointer, type BlueprintNode, type CustomPage, type ResolvedManifest } from '@trivia/blueprint'

import { CompileError } from '../compile.js'
import type { AttributeIR, JsxIR } from '../ir.js'
import { compareBytes } from '../print/style.js'

export function lowerJsx(
  page: CustomPage,
  manifestOf: (type: string) => ResolvedManifest,
  component: (manifest: ResolvedManifest) => string,
  expression: (pointer: string) => string,
  wire: (id: string, tag: string, props: Map<string, AttributeIR['value']>) => void,
): JsxIR {
  const childrenByParent = new Map<string, Array<[string, BlueprintNode]>>()
  for (const [id, node] of Object.entries(page.nodes)) {
    if (node.parent === null) continue
    const children = childrenByParent.get(node.parent) ?? []
    children.push([id, node])
    childrenByParent.set(node.parent, children)
  }

  function lower(id: string): JsxIR {
    const node = page.nodes[id]!
    const manifest = manifestOf(node.type)
    const tag = component(manifest)
    const attributes = new Map<string, AttributeIR['value']>(Object.entries({ ...page.props[id], ...page.styles[id] })
      .map(([name, value]) => [name, { kind: 'static', value }]))
    for (const name of Object.keys(page.bindings[id] ?? {})) {
      attributes.set(name, { kind: 'expr', code: expression(toPointer(['bindings', id, name])) })
    }
    wire(id, tag, attributes)
    const content = attributes.get('children')
    const asChild = content?.kind === 'expr' || (content?.kind === 'static' && typeof content.value === 'string')
    if (asChild) attributes.delete('children')
    const props = [...attributes].sort(([a], [b]) => compareBytes(a, b)).map(([name, value]) => ({ name, value }))
    const nodes = (childrenByParent.get(id) ?? []).sort(([a, left], [b, right]) =>
      compareBytes(left.order, right.order) || compareBytes(a, b))
    const children: JsxIR[] = []
    if (content?.kind === 'expr') children.push({ kind: 'expr', code: content.code })
    if (content?.kind === 'static' && typeof content.value === 'string') children.push({ kind: 'text', value: content.value })
    for (const [child, model] of nodes) {
      if (!manifest.slots.some((slot) => slot.name === model.slot && slot.kind === 'nodes')) {
        throw new CompileError('invalid_result', manifest.type + ' has no node slot ' + model.slot)
      }
      children.push(lower(child))
    }
    return { kind: 'element', tag, props, children }
  }

  return lower(page.root)
}
