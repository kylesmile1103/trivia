import type { BlueprintNode, CustomPage, ResolvedManifest } from '@trivia/blueprint'

import { CompileError } from '../compile.js'
import type { AttributeIR, JsxIR } from '../ir.js'
import { compareBytes } from '../print/style.js'

export function lowerJsx(
  page: CustomPage,
  manifestOf: (type: string) => ResolvedManifest,
  component: (manifest: ResolvedManifest) => string,
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
    const data: Record<string, unknown> = { ...page.props[id], ...page.styles[id] }
    const text = data.children
    delete data.children
    const props: AttributeIR[] = Object.entries(data).sort(([a], [b]) => compareBytes(a, b))
      .map(([name, value]) => ({ name, value: { kind: 'static', value } }))
    const nodes = (childrenByParent.get(id) ?? []).sort(([a, left], [b, right]) =>
      compareBytes(left.order, right.order) || compareBytes(a, b))
    const children: JsxIR[] = []
    if (typeof text === 'string') children.push({ kind: 'text', value: text })
    else if (text !== undefined) props.push({ name: 'children', value: { kind: 'static', value: text } })
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
