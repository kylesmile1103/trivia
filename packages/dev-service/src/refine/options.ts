// A contract enum's values where a page writes them (docs/product.md, slice 3): a list column's
// `DataTableFilterCombobox options={[…]}`, a form field's `z.enum([…])` and its control's
// `<SelectItem>`s. Each place is a "site". The `align` fix adds and removes single options at
// each site and touches nothing else: kept options keep their labels, quotes, extra properties
// and position. Drift and the planner read sites the same way (RefineAdapter#enumSites), so a
// fix is offered only when the plan will work.

import { escapeJsxText, optionLabel } from './columns.js'

/** Where a page writes an enum's values. */
export type SiteKind = 'rule' | 'items' | 'column'

/** One value as a site writes it. */
export interface OptionItem {
  value: string
  /** 1-based line where it is written. */
  line: number
  /** A `<SelectItem>`'s locator, as read from the file on disk. */
  locator?: string
  /** A `<SelectItem>`: false under a `{…}` expression, where it cannot be removed by splicing. */
  direct?: boolean
}

/** A site Trivia can read: plain string values. */
export interface ReadableSite {
  kind: SiteKind
  /**
   * `literal`: the values are distinct and each can be edited on its own. `blocked`: readable
   * but not spliceable (`why`): compared with the contract, and when stale the fix is `rebuild`.
   */
  state: 'literal' | 'blocked'
  /** Rule and column: the array's value path. Items: the control's locator when they were read. */
  at: string
  items: OptionItem[]
  why?: string
}

/**
 * One reader's verdict on a site (⚑ docs/product.md, slice 3). `absent`: the page has no such
 * place. `opaque`: written some other way (a constant, a spread, a `.map`), so no verdict and
 * never edited; `source` names it for the plan's warning.
 */
export type OptionSite = { kind: SiteKind; state: 'absent' } | OpaqueSite | ReadableSite

export interface OpaqueSite {
  kind: SiteKind
  state: 'opaque'
  /** What it is, after "the Status ": "rule `z.enum(STATUSES)`", "filter `options={statusOptions}`". */
  what: string
}

/** The sites of one column (list) or one field (form). */
export interface EnumSites {
  column?: OptionSite
  rule?: OptionSite
  items?: OptionSite
  /** A form's `defaultValues.<field>`, when it is a string literal. */
  default?: { value: string; line: number } | null
}

export const isReadable = (site: OptionSite | undefined): site is ReadableSite => site?.state === 'literal' || site?.state === 'blocked'

export const values = (site: ReadableSite) => site.items.map((i) => i.value)

/** The same values, in any order. */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((v) => right.has(v))
}

/** True when a readable site's values differ from the contract's. */
export const isStale = (site: ReadableSite, contract: readonly string[]) => !sameSet(values(site), contract)

/** A site of plain string values: `literal` when each can be edited on its own, else `blocked`. */
export function readableSite(kind: SiteKind, at: string, items: OptionItem[]): ReadableSite {
  const twice = items.find((item, i) => items.findIndex((other) => other.value === item.value) !== i)
  const blocked = (why: string): ReadableSite => ({ kind, state: 'blocked', at, items, why })
  if (twice) return blocked(`"${twice.value}" is written twice`)
  if (kind === 'items') {
    const guarded = items.find((i) => i.direct === false)
    if (guarded) return blocked(`its "${guarded.value}" <SelectItem> is inside a {…} expression`)
  } else {
    // `[=value]` and `[value=…]` end at the first `]`, and need a value.
    const unnamed = items.find((i) => i.value === '' || i.value.includes(']'))
    if (unnamed) return blocked(`a value path cannot name "${unnamed.value}"`)
  }
  return { kind, state: 'literal', at, items }
}

/** The plan's warning for an opaque site it left as written. */
export const opaqueWarning = (file: string, label: string, site: OpaqueSite) => `${file}: the ${label} ${site.what} is not a literal list, so it was left as written`

/** What a site is called in a refusal: "the Status rule", "the Status <SelectItem>s", "the Status filter options". */
export const siteName = (label: string, site: { kind: SiteKind }) =>
  `the ${label} ${site.kind === 'rule' ? 'rule' : site.kind === 'items' ? '<SelectItem>s' : 'filter options'}`

/**
 * The values the stale sites write that the contract no longer has, and the lines that write
 * them: an `align` removes those lines, and rewrites `fallback` (a form's default) when it names
 * one, so code there is no leftover.
 */
export function removedValues(stale: readonly ReadableSite[], contract: readonly string[], fallback?: { value: string; line: number } | null): { removed: string[]; own: Set<number> } {
  const removed = [...new Set(stale.flatMap(values))].filter((v) => !contract.includes(v))
  const own = new Set(stale.flatMap((s) => s.items.filter((i) => removed.includes(i.value)).map((i) => i.line)))
  if (fallback && removed.includes(fallback.value)) own.add(fallback.line)
  return { removed, own }
}

/** One edit to a site's values. `index` counts the site's items after the edits before it. */
export type OptionEdit =
  | { kind: 'insert'; value: string; index: number; anchor: { value: string; placement: 'before' | 'after' } | null }
  | { kind: 'remove'; value: string }

/**
 * The edits that turn a site's values `have` into the contract's `want` (⚑ docs/product.md,
 * slice 3), keeping the site's order. Each missing value, in contract order, goes after the
 * nearest value before it in the contract that the site has, else before the nearest one after
 * it, else after the last item. Then each value the contract no longer has is removed. Inserts
 * come first so that an anchor always exists, even when every value changes.
 */
export function optionEdits(have: readonly string[], want: readonly string[]): OptionEdit[] {
  const list = [...have]
  const out: OptionEdit[] = []
  want.forEach((value, i) => {
    if (list.includes(value)) return
    let edit: OptionEdit | null = null
    for (let j = i - 1; j >= 0 && !edit; j -= 1) {
      const at = list.indexOf(want[j]!)
      if (at >= 0) edit = { kind: 'insert', value, index: at + 1, anchor: { value: want[j]!, placement: 'after' } }
    }
    for (let j = i + 1; j < want.length && !edit; j += 1) {
      const at = list.indexOf(want[j]!)
      if (at >= 0) edit = { kind: 'insert', value, index: at, anchor: { value: want[j]!, placement: 'before' } }
    }
    edit ??= { kind: 'insert', value, index: list.length, anchor: list.length > 0 ? { value: list.at(-1)!, placement: 'after' } : null }
    list.splice(edit.index, 0, value)
    out.push(edit)
  })
  for (const value of have) if (!want.includes(value)) out.push({ kind: 'remove', value })
  return out
}

type Op = Record<string, unknown>

const str = (s: string) => JSON.stringify(s)

/** The value ops for an array site: the rule's `z.enum([…])` or a column's `options={[…]}`. */
export function arrayOps(site: ReadableSite, edits: readonly OptionEdit[]): Op[] {
  return edits.map((e): Op => {
    if (e.kind === 'remove') return { op: 'removeElement', path: site.kind === 'rule' ? `${site.at}[=${e.value}]` : `${site.at}[value=${e.value}]` }
    // As the generators write them (fields.ts, columns.ts); no imports: none is needed.
    const value = site.kind === 'rule' ? str(e.value) : `{ label: ${str(optionLabel(e.value))}, value: ${str(e.value)} }`
    return { op: 'insertElement', path: site.at, index: e.index, value }
  })
}

/** A new `<SelectItem>`, as the generator writes it (fields.ts), with a value JSX can hold as an attribute string. */
export function selectItem(value: string): string {
  const attr = /^[^"\\&\r\n]*$/.test(value) ? `"${value}"` : `{${str(value)}}`
  return `<SelectItem value=${attr}>${escapeJsxText(optionLabel(value))}</SelectItem>`
}

/**
 * The JSX ops for a control's `<SelectItem>`s. Their locators were read with the control at
 * `site.at`; they are rebased on `control`, where the plan's earlier changes have moved it, and
 * kept current as each op renumbers the items after it. `shifted` hears of each renumbering, for
 * what else the caller tracks. An item is never a control's ancestor, so no control moves.
 */
export function itemOps(site: ReadableSite, edits: readonly OptionEdit[], control: string, shifted: (at: string, by: 1 | -1) => void = () => {}): Op[] {
  let items = site.items.map((i) => ({ value: i.value, locator: control + i.locator!.slice(site.at.length) }))
  const shift = (at: string, by: 1 | -1) => {
    items = items.map((i) => ({ ...i, locator: shiftLocator(i.locator, at, by) }))
    shifted(at, by)
  }
  const ops: Op[] = []
  for (const e of edits) {
    if (e.kind === 'insert') {
      // A new item joins its anchor's parent (a <SelectGroup> keeps its own).
      const anchor = e.anchor && items.find((i) => i.value === e.anchor!.value)
      if (!anchor || !e.anchor) throw new Error(`no <SelectItem> to put "${e.value}" next to`)
      ops.push({ op: 'insert', target: anchor.locator, expectedName: 'SelectItem', placement: e.anchor.placement, snippet: selectItem(e.value) })
      const added = siblingLocator(anchor.locator, e.anchor.placement)
      shift(added, 1)
      items.push({ value: e.value, locator: added })
    } else {
      const item = items.find((i) => i.value === e.value)
      if (!item) throw new Error(`no <SelectItem> has the value "${e.value}"`)
      ops.push({ op: 'remove', target: item.locator, expectedName: 'SelectItem' })
      items = items.filter((i) => i !== item)
      shift(item.locator, -1)
    }
  }
  return ops
}

/** A locator's `file#scope#` and its index path. */
export function splitLocator(loc: string): { head: string; path: number[] } {
  const at = loc.lastIndexOf('#') + 1
  return { head: loc.slice(0, at), path: loc.slice(at).split('.').map(Number) }
}

/** Where an element inserted before or after the one at `loc` lands. */
export function siblingLocator(loc: string, placement: 'before' | 'after'): string {
  const { head, path } = splitLocator(loc)
  return head + [...path.slice(0, -1), path.at(-1)! + (placement === 'after' ? 1 : 0)].join('.')
}

/**
 * `loc` after an element is inserted at the slot `at` names (`by` 1) or the element at `at` is
 * removed (`by` -1). Locators are positions (CLAUDE.md rule 4): the siblings from that slot on
 * (an insert) or after it (a removal), and everything inside them, move by one; nothing else does.
 */
export function shiftLocator(loc: string, at: string, by: 1 | -1): string {
  const { head, path } = splitLocator(at)
  const depth = path.length - 1
  const from = path[depth]! + (by === -1 ? 1 : 0)
  const l = splitLocator(loc)
  const inside = l.head === head && l.path.length > depth && path.slice(0, depth).every((seg, i) => l.path[i] === seg)
  if (!inside || l.path[depth]! < from) return loc
  const moved = [...l.path]
  moved[depth] = moved[depth]! + by
  return head + moved.join('.')
}
