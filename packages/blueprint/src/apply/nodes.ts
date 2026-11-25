// Node ops: addNode, removeNode, moveNode, renameNode (LLD-01 section 4). Positions are given
// relative to siblings and turned into fractional keys here, so callers never invent order keys
// and a move changes the moved node's entry only (FR-BP-08).
import { mentionsNode, expressionsOf, rewriteExpressions } from '../expressions.js'
import { newId } from '../ids.js'
import type { OpOf } from '../types/ops.js'
import { NODE_MAPS, type CustomPage } from '../types/page.js'
import { expressionInputs, readExpressionEnvelope, type ExpressionBinding, type NativeDiagnostic } from '../validate/expressions.js'
import { editCustomPage, orderAt, refuse, requireFreeName, requireNode, subtree, type Draft } from './draft.js'

export function addNode(draft: Draft, op: OpOf<'addNode'>): void {
  const page = editCustomPage(draft, op.doc)
  requireNode(page, op.parent, op.expectedType)
  requireFreeName(page, op.name)
  const order = orderAt(page, op.parent, op.slot, op)
  const id = newId('n', draft.options.ids)
  page.nodes[id] = { type: op.type, name: op.name, parent: op.parent, slot: op.slot, order }
  draft.created[`${page.name}/${op.name}`] = id
}

export function removeNode(draft: Draft, op: OpOf<'removeNode'>): void {
  const page = editCustomPage(draft, op.doc)
  requireNode(page, op.node, op.expectedType)
  if (op.node === page.root) refuse('invalid_op', `${op.node} is the page's root; delete the page instead`)
  const gone = subtree(page, op.node)
  for (const id of gone) {
    delete page.nodes[id]
    for (const map of NODE_MAPS) delete page[map][id]
  }
  for (const key of Object.keys(page.actions)) {
    if (gone.has(key.slice(0, key.indexOf('.')))) delete page.actions[key]
  }
}

export function moveNode(draft: Draft, op: OpOf<'moveNode'>): void {
  const page = editCustomPage(draft, op.doc)
  const node = requireNode(page, op.node, op.expectedType)
  if (op.node === page.root) refuse('invalid_op', `${op.node} is the page's root and cannot move`)
  requireNode(page, op.parent)
  if (subtree(page, op.node).has(op.parent)) refuse('invalid_op', `${op.parent} is inside ${op.node}; a node cannot move into itself`)
  node.order = orderAt(page, op.parent, op.slot, op, op.node)
  node.parent = op.parent
  node.slot = op.slot
}

export function renameNode(draft: Draft, op: OpOf<'renameNode'>): void {
  const page = editCustomPage(draft, op.doc)
  const node = requireNode(page, op.node, op.expectedType)
  if (node.name === op.name) return
  requireFreeName(page, op.name, op.node)
  const from = node.name
  const tools = draft.options.expressions
  if (tools?.renameReferences) {
    renamePageReferences(page, op.doc, tools.renameReferences, from, op.name)
  } else if (tools?.renameNodeReference) {
    const rename = tools.renameNodeReference.bind(tools)
    rewriteExpressions(page, (expr) => rename(expr, from, op.name))
  } else {
    // Without the expression compiler a reference cannot be rewritten safely: refuse rather
    // than leave it pointing at a name that no longer exists.
    const uses = expressionsOf(page).filter((site) => mentionsNode(site.expr, from))
    if (uses.length > 0) {
      refuse('invalid_op', `${uses.length} expression(s) refer to ui.${from}; renaming needs the expression compiler (LLD-03)`, {
        pointers: uses.map((site) => site.pointer),
      })
    }
  }
  node.name = op.name
}

type RenameResponse = { unit: 'utf16'; results: Array<{ id: string; ts?: string; diagnostics?: NativeDiagnostic[] }> }

function renamePageReferences(page: CustomPage, doc: string, rename: ExpressionBinding, from: string, to: string): void {
  const expressions = expressionInputs(page)
  if (expressions.length === 0) return
  const { unit, results } = readExpressionEnvelope<RenameResponse>(rename(JSON.stringify({ from, to, expressions })))
  const byPointer = new Map(results.map((result) => [result.id, result]))
  if (results.length !== expressions.length || byPointer.size !== results.length) {
    refuse('invalid_op', 'The expression compiler returned an incomplete rename')
  }
  const blocked = expressions.filter(({ id }) => {
    const result = byPointer.get(id)
    return typeof result?.ts !== 'string' || result.diagnostics?.some(({ severity }) => severity === 'error')
  })
  if (blocked.length > 0) {
    refuse('invalid_op', `Could not safely rename ui.${from} in ${blocked.length} expression(s)`, {
      pointers: blocked.map(({ id }) => id),
      diagnostics: blocked.flatMap(({ id: pointer }) => (byPointer.get(pointer)?.diagnostics ?? []).map(
        ({ start, end, ...finding }) => ({ ...finding, doc, pointer, span: { start, end, unit } }),
      )),
    })
  }
  rewriteExpressions(page, (source, pointer) => byPointer.get(pointer)?.ts ?? source)
}
