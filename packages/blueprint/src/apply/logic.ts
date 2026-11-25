// Logic ops: setState, removeState, setQuery, removeQuery, setActions (T016).
import type { OpOf } from '../types/ops.js'
import { editCustomPage, refuse, requireFreeName, requireNode, type Draft } from './draft.js'

export function setState(draft: Draft, op: OpOf<'setState'>): void {
  const page = editCustomPage(draft, op.doc)
  if (!Object.hasOwn(page.state, op.name)) requireFreeName(page, op.name)
  page.state[op.name] = { type: op.type, initial: op.initial }
}

export function removeState(draft: Draft, op: OpOf<'removeState'>): void {
  const page = editCustomPage(draft, op.doc)
  if (!Object.hasOwn(page.state, op.name)) {
    refuse('invalid_op', `No state named "${op.name}" in page ${page.name}`, { name: op.name })
  }
  delete page.state[op.name]
}

export function setQuery(draft: Draft, op: OpOf<'setQuery'>): void {
  const page = editCustomPage(draft, op.doc)
  if (!Object.hasOwn(page.queries, op.name)) requireFreeName(page, op.name)
  page.queries[op.name] = op.query
}

export function removeQuery(draft: Draft, op: OpOf<'removeQuery'>): void {
  const page = editCustomPage(draft, op.doc)
  if (!Object.hasOwn(page.queries, op.name)) {
    refuse('invalid_op', `No query named "${op.name}" in page ${page.name}`, { name: op.name })
  }
  delete page.queries[op.name]
}

export function setActions(draft: Draft, op: OpOf<'setActions'>): void {
  const page = editCustomPage(draft, op.doc)
  requireNode(page, op.node, op.expectedType)
  const key = `${op.node}.${op.event}`
  if (op.steps.length === 0) delete page.actions[key]
  else page.actions[key] = op.steps
}
