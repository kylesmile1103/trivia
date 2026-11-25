import { configuredTabs, manifestSlots, toPointer, type BlueprintNode, type CustomPage, type ResolvedManifest } from '@trivia/blueprint'

import { CompileError } from '../compile.js'
import type { PrintStyle } from '../facts.js'
import type { AttributeIR, JsxIR } from '../ir.js'
import { kitElement } from './kit-elements.js'
import { compareBytes } from '../print/style.js'

export interface RepeatLocal { alias: string; item: string; index?: string }

export function lowerJsx(
  page: CustomPage,
  manifestOf: (type: string) => ResolvedManifest,
  component: (manifest: ResolvedManifest, part?: string) => string,
  expression: (pointer: string) => string,
  wire: (id: string, tag: string, props: Map<string, AttributeIR['value']>, repeated: boolean) => void,
  repeats: ReadonlyMap<string, RepeatLocal>,
  style: PrintStyle,
  expand: (id: string, manifest: ResolvedManifest, element: Extract<JsxIR, { kind: 'element' }>) => JsxIR,
): JsxIR {
  const childrenByParent = new Map<string, Array<[string, BlueprintNode]>>()
  for (const [id, node] of Object.entries(page.nodes)) {
    if (node.parent === null) continue
    const children = childrenByParent.get(node.parent) ?? []
    children.push([id, node])
    childrenByParent.set(node.parent, children)
  }

  function lower(id: string, outerRepeat = false): JsxIR {
    const repeat = repeats.get(id)
    const repeated = outerRepeat || repeat !== undefined
    const node = page.nodes[id]!
    const manifest = manifestOf(node.type)
    const tag = manifest.composite ? manifest.source.import.name : component(manifest)
    const attributes = new Map<string, AttributeIR['value']>(Object.entries({ ...page.props[id], ...page.styles[id] })
      .map(([name, value]) => [name, { kind: 'static', value }]))
    for (const name of Object.keys(page.bindings[id] ?? {})) {
      attributes.set(name, { kind: 'expr', code: expression(toPointer(['bindings', id, name])) })
    }
    wire(id, tag, attributes, repeated)
    if (repeat) attributes.set('key', { kind: 'expr', code: expression(toPointer(['control', id, 'key'])) })
    const content = attributes.get('children')
    const asChild = content?.kind === 'expr' || (content?.kind === 'static' && typeof content.value === 'string')
    if (asChild) attributes.delete('children')
    const props = [...attributes].sort(([a], [b]) => compareBytes(a, b)).map(([name, value]) => ({ name, value }))
    const nodes = (childrenByParent.get(id) ?? []).sort(([a, left], [b, right]) =>
      compareBytes(left.order, right.order) || compareBytes(a, b))
    const children: JsxIR[] = []
    if (content?.kind === 'expr') children.push({ kind: 'expr', code: content.code })
    if (content?.kind === 'static' && typeof content.value === 'string') children.push({ kind: 'text', value: content.value })
    const slots = manifestSlots(manifest, page.props[id])
    const tabs = configuredTabs(manifest, page.props[id]?.['tabs'])
    for (const [, model] of nodes) {
      if (!slots.some((slot) => slot.name === model.slot && slot.kind === 'nodes')) {
        throw new CompileError('invalid_result', manifest.type + ' has no node slot ' + model.slot)
      }
    }
    for (const slot of slots) {
      const contents = nodes.filter(([, model]) => model.slot === slot.name)
        .map(([child]) => lower(child, repeated))
      const wrapper = slot.wrapper ?? manifest.source.parts?.[slot.name]
      if (contents.length || tabs) {
        const props: AttributeIR[] = tabs ? [{ name: 'value', value: { kind: 'static', value: slot.name } }] : []
        if (wrapper) children.push({ kind: 'element', tag: component(manifest, wrapper), props, children: contents })
        else children.push(...contents)
      }
    }
    const element: Extract<JsxIR, { kind: 'element' }> = { kind: 'element', tag, props, children }
    let tree: JsxIR = manifest.composite ? expand(id, manifest, element) : kitElement(manifest, element, tabs, (part) => component(manifest, part),
      (part) => component(manifestOf('Popover'), part), style)
    if (page.control[id]?.when !== undefined) {
      tree = { kind: 'cond', test: expression(toPointer(['control', id, 'when'])), child: tree }
    }
    if (repeat) {
      tree = {
        kind: 'repeat', list: expression(toPointer(['control', id, 'each'])),
        item: repeat.item, ...(repeat.index && { index: repeat.index }), child: tree,
      }
    }
    return tree
  }

  return lower(page.root)
}
