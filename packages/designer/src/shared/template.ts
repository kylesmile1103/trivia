// What the palette and the Data panel insert, and the canvas drops: the contract between them.

import type { ImportSpec, Op, Placement, QueryBinding } from '@/shared/engine/types'

/** One insertable element: what a palette item (or a Data panel action) writes into the user's source. */
export interface Template {
  /** Primary component, e.g. "Card": the root tag of `snippet`. */
  component: string
  label: string
  /** Exactly one JSX element, unindented (the engine indents it). */
  snippet: string
  imports: ImportSpec[]
  /** Ops run first, in the same undo entry: e.g. creating the file of the component it uses. */
  before?: Op[]
  /** Bind the inserted element to a TanStack Query, in the same undo entry (`bindQuery` minus its target). */
  bind?: Omit<QueryBinding, 'target' | 'expectedName'>
}

/** dataTransfer type carrying a JSON `Template` (set by the palette, read by the canvas on drop). */
export const TEMPLATE_MIME = 'application/x-trivia-template'

/** Where a template goes: next to or into `target`, whose tag is `expectedName` and which has `childCount` JSX children. */
export interface InsertPoint {
  target: string
  expectedName: string
  placement: Placement
  childCount: number
}

/** The ops that insert `template` at `at`, as one transaction (one undo entry). */
export function templateOps(template: Template, at: InsertPoint): Op[] {
  const insert: Op = {
    op: 'insert',
    target: at.target,
    expectedName: at.expectedName,
    placement: at.placement,
    snippet: template.snippet,
    imports: template.imports,
  }
  const ops: Op[] = [...(template.before ?? []), insert]
  if (template.bind) ops.push({ op: 'bindQuery', target: insertedLocator(at), expectedName: template.component, ...template.bind })
  return ops
}

/**
 * The locator the inserted element will have. Locators are positions (CLAUDE.md rule 4): an
 * element inserted before `target` takes its index, after it the next one, and as the last
 * child the index after the last JSX child. The bind's tag name check refuses the batch if
 * this were ever wrong, instead of binding another element.
 */
export function insertedLocator({ target, placement, childCount }: InsertPoint): string {
  const cut = target.lastIndexOf('#')
  const prefix = target.slice(0, cut + 1)
  const path = target.slice(cut + 1).split('.').map(Number)
  switch (placement) {
    case 'before':
      return target
    case 'after': {
      const last = path.pop() ?? 0
      return prefix + [...path, last + 1].join('.')
    }
    case 'firstChild':
      return `${target}.0`
    case 'lastChild':
      return `${target}.${childCount}`
  }
}
