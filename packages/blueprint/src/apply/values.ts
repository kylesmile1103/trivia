// Value ops: setProp, setBinding, setStyle, setControl (T015).
import type { OpOf } from '../types/ops.js'
import { editCustomPage, requireNode, type Draft } from './draft.js'

function removeValue(values: Record<string, Record<string, unknown>>, node: string, prop: string): void {
  const entry = values[node]
  if (entry === undefined) return
  delete entry[prop]
  if (Object.keys(entry).length === 0) delete values[node]
}

export function setProp(draft: Draft, op: OpOf<'setProp'>): void {
  const page = editCustomPage(draft, op.doc)
  requireNode(page, op.node, op.expectedType)
  if (op.value === null) {
    removeValue(page.props, op.node, op.prop)
    return
  }
  const props = (page.props[op.node] ??= {})
  props[op.prop] = op.value
  removeValue(page.bindings, op.node, op.prop)
}

export function setBinding(draft: Draft, op: OpOf<'setBinding'>): void {
  const page = editCustomPage(draft, op.doc)
  requireNode(page, op.node, op.expectedType)
  if (op.expr === null) {
    removeValue(page.bindings, op.node, op.prop)
    return
  }
  const bindings = (page.bindings[op.node] ??= {})
  bindings[op.prop] = op.expr
  removeValue(page.props, op.node, op.prop)
}

export function setStyle(draft: Draft, op: OpOf<'setStyle'>): void {
  const page = editCustomPage(draft, op.doc)
  requireNode(page, op.node, op.expectedType)
  if (op.className === null || op.className === '') delete page.styles[op.node]
  else page.styles[op.node] = { className: op.className }
}

export function setControl(draft: Draft, op: OpOf<'setControl'>): void {
  const page = editCustomPage(draft, op.doc)
  requireNode(page, op.node, op.expectedType)
  if (op.control === null) delete page.control[op.node]
  else page.control[op.node] = op.control
}
