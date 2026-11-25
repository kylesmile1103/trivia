// The working copy a batch is applied to, and the guards every op handler shares. Handlers
// refuse by throwing a Refusal, which apply() turns into an ApplyError for that op; nothing
// leaves this module as an exception.
import type { IdSource } from '../ids.js'
import { keyBetween } from '../order.js'
import { compareBytes, type BlueprintDoc } from '../serialize.js'
import type { Blueprint } from '../store.js'
import type { AppDoc } from '../types/app.js'
import { applyError, type ApplyError, type ErrorCode } from '../types/diagnostics.js'
import type { BlueprintNode, CustomPage, PageDoc } from '../types/page.js'
import type { ValidationContext } from '../validate/context.js'
import type { ExpressionBinding } from '../validate/expressions.js'

export class Refusal extends Error {
  constructor(readonly error: ApplyError) {
    super(error.message)
  }
}

export function refuse(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new Refusal(applyError(code, message, details ? { details } : {}))
}

/** What this package needs from the expression compiler (LLD-03), injected. */
export interface ExpressionTools {
  /** Batch binding from LLD-03, called once with the page's expression sites. */
  renameReferences?: ExpressionBinding
  /** Earlier single-source adapter, used by callers that have not switched to the batch binding. */
  renameNodeReference?(expr: string, from: string, to: string): string
}

export interface ApplyOptions {
  /** Where new page and node ids come from. Injected, so tests and fixtures are stable. */
  ids: IdSource
  /** Without it, renameNode is refused when an expression mentions the node. */
  expressions?: ExpressionTools
  /** Manifests, contract and expression checks (layers 3 to 5). Their findings never block. */
  ctx?: ValidationContext
}

export class Draft {
  /** Documents the batch touched: a private copy, or null once deleted. */
  private readonly touched = new Map<string, BlueprintDoc | null>()
  /** Names of what the batch created, to the ids generated for them. */
  readonly created: Record<string, string> = {}

  constructor(
    readonly base: Blueprint,
    readonly options: ApplyOptions,
  ) {}

  has(path: string): boolean {
    return this.touched.has(path) ? this.touched.get(path) !== null : Object.hasOwn(this.base.docs, path)
  }

  /** A document to change: a private copy, made on first use. */
  edit(path: string): BlueprintDoc {
    const mine = this.touched.get(path)
    if (mine) return mine
    if (mine === null || !Object.hasOwn(this.base.docs, path)) refuse('invalid_op', `${path} does not exist`)
    const entry = this.base.docs[path]
    if (!entry?.doc) refuse('invalid_op', `${path} has errors (${entry?.diagnostics[0]?.code ?? 'unknown'}); fix the file first`)
    const copy = structuredClone(entry.doc)
    this.touched.set(path, copy)
    return copy
  }

  put(path: string, doc: BlueprintDoc): void {
    this.touched.set(path, doc)
  }

  remove(path: string): void {
    this.touched.set(path, null)
  }

  /** The documents the batch touched, in path order. */
  changes(): Array<[string, BlueprintDoc | null]> {
    return [...this.touched.entries()].sort(([a], [b]) => compareBytes(a, b))
  }
}

export function editApp(draft: Draft, path: string): AppDoc {
  return draft.edit(path) as AppDoc
}

export function editPage(draft: Draft, path: string): PageDoc {
  return draft.edit(path) as PageDoc
}

export function editCustomPage(draft: Draft, path: string): CustomPage {
  const page = editPage(draft, path)
  if (page.kind !== 'custom') refuse('invalid_op', `${path} is a ${page.kind} page: only custom pages have nodes, state, queries and actions`)
  return page
}

/** The node an op addresses, checked against the type its author expected (409 otherwise). */
export function requireNode(page: CustomPage, id: string, expectedType?: string): BlueprintNode {
  const node = page.nodes[id]
  if (!node) refuse('node_not_found', `No node ${id} in page ${page.name}`, { node: id })
  if (expectedType !== undefined && node.type !== expectedType) {
    refuse('conflict', `Node ${id} is a ${node.type}, not a ${expectedType}`, { node: id, expectedType, actualType: node.type })
  }
  return node
}

/** Nodes, state and queries share one namespace per page, since emitted code names them all. */
export function requireFreeName(page: CustomPage, name: string, except?: string): void {
  const taken =
    Object.entries(page.nodes).some(([id, node]) => id !== except && node.name === name) ||
    (except !== name && (Object.hasOwn(page.state, name) || Object.hasOwn(page.queries, name)))
  if (taken) refuse('conflict', `The name "${name}" is already used in page ${page.name}`, { name })
}

/** The children of `parent` in `slot`, in order: by order key bytewise, then by id. */
export function siblings(page: CustomPage, parent: string, slot: string, exclude?: string): Array<[string, BlueprintNode]> {
  return Object.entries(page.nodes)
    .filter(([id, node]) => id !== exclude && node.parent === parent && node.slot === slot)
    .sort(([ia, a], [ib, b]) => compareBytes(a.order, b.order) || compareBytes(ia, ib))
}

export interface Position {
  before?: string | undefined
  after?: string | undefined
  index?: number | undefined
}

/** The order key for a node placed at `position` among the children of `parent` in `slot`. */
export function orderAt(page: CustomPage, parent: string, slot: string, position: Position, exclude?: string): string {
  const list = siblings(page, parent, slot, exclude)
  const at = (sibling: string) => {
    const index = list.findIndex(([id]) => id === sibling)
    if (index < 0) refuse('invalid_op', `${sibling} is not a child of ${parent} in slot "${slot}"`, { node: sibling })
    return index
  }
  let lower: string | null
  let upper: string | null
  if (position.before !== undefined) {
    const index = at(position.before)
    lower = list[index - 1]?.[1].order ?? null
    upper = list[index]?.[1].order ?? null
  } else if (position.after !== undefined) {
    const index = at(position.after)
    lower = list[index]?.[1].order ?? null
    upper = list[index + 1]?.[1].order ?? null
  } else if (position.index !== undefined) {
    if (position.index > list.length) refuse('invalid_op', `Index ${position.index} is past the ${list.length} children of ${parent} in slot "${slot}"`)
    lower = list[position.index - 1]?.[1].order ?? null
    upper = list[position.index]?.[1].order ?? null
  } else {
    lower = list.at(-1)?.[1].order ?? null
    upper = null
  }
  try {
    return keyBetween(lower, upper)
  } catch {
    refuse('invalid_op', `Two children of ${parent} share the order key "${lower}"; move one of them first`)
  }
}

/** A node and everything under it. Safe on parent cycles. */
export function subtree(page: CustomPage, id: string): Set<string> {
  const found = new Set([id])
  const children = new Map<string, string[]>()
  for (const [child, node] of Object.entries(page.nodes)) {
    if (node.parent !== null) children.set(node.parent, [...(children.get(node.parent) ?? []), child])
  }
  const queue = [id]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift() as string) ?? []) {
      if (!found.has(child)) {
        found.add(child)
        queue.push(child)
      }
    }
  }
  return found
}
