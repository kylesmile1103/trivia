// Contract drift (docs/product.md, slice 3): where a Refine page no longer matches the contract
// the manifest describes. Each issue says what is out of step and, when Trivia can fix it, the
// column or field changes that do (planned like any other: one undo entry).

import type { ColumnChange, FieldChange, Page } from './index.js'
import { type EnumSites, type ReadableSite, isReadable, isStale, removedValues, values } from './options.js'
import type { FieldInfo } from './page.js'
import { boundWords, hasDiff, ruleDiff } from './rules.js'

export type DriftCode =
  /** It shows or sends a field the contract no longer has. */
  | 'missing_field'
  /** Its enum values (filter options, select items, zod enum) differ from the contract's. */
  | 'enum_changed'
  /** It treats the field as another type than the contract now gives it. */
  | 'type_changed'
  /** A create form lacks a field the contract now requires. */
  | 'required_missing'
  /** A field's rule has other bounds than the contract states (`maxLength` 100 → 500). */
  | 'constraint_changed'
  /** A field's rule lets through a missing or null value the contract no longer accepts. */
  | 'optionality_changed'

export interface DriftFix {
  label: string
  /** For a list page: column changes; for a form: field changes. */
  changes: Array<Record<string, unknown>>
}

export interface DriftIssue {
  code: DriftCode
  /** The column key or field name. */
  name: string
  message: string
  line: number | null
  fix: DriftFix | null
  /**
   * Other code in the file that still names what the fix removes (it breaks with the fix): a
   * removed form field, or an enum value the contract dropped.
   */
  references?: Array<{ line: number; text: string }>
}

export interface PageDrift {
  file: string
  component: string
  kind: 'list' | 'form'
  issues: DriftIssue[]
}

const ruleFamily: Record<FieldInfo['shape'], RegExp> = {
  text: /^z\.(string|email|uuid|url|guid|cuid|ulid|nanoid|ipv4|ipv6|base64|e164|jwt)\b/,
  enum: /^z\.(enum|literal|union)\b/,
  number: /^z\.(number|int|float|bigint|coerce\.number)\b/,
  boolean: /^z\.(boolean|coerce\.boolean)\b/,
  date: /^z\.(iso\.date\b|string\b|date\b|coerce\.date\b)/,
  dateTime: /^z\.(iso\.datetime\b|string\b|date\b|coerce\.date\b)/,
  list: /^z\.(array|tuple|set)\b/,
  other: /^z\./,
}

/** The refine-ui filter a column header uses for each field shape. */
const filterFor: Partial<Record<FieldInfo['shape'], string>> = {
  text: 'DataTableFilterDropdownText',
  enum: 'DataTableFilterCombobox',
  number: 'DataTableFilterDropdownNumeric',
  date: 'DataTableFilterDropdownDateRangePicker',
  dateTime: 'DataTableFilterDropdownDateRangePicker',
}

type References = Array<{ line: number; text: string }>

/**
 * The drift of each page against its contract. `contract.fields` are the contract fields a list
 * page shows or a form page sends (null: the page matches no contract). `sites` are where the
 * page writes each enum field's values (options.ts), keyed by column key or field name.
 */
export function pageDrift(
  page: Page,
  contract: { fields: FieldInfo[] | null; required: string[] },
  sites: Map<string, EnumSites>,
  /** Where a form's file still names a field outside the field itself. */
  leftover: (name: string) => References = () => [],
  /** Where the file still names each removed enum value, outside the lines `own` (what the fix rewrites). */
  valueMentions: (removed: string[], own: Set<number>) => Array<{ value: string; references: References }> = () => [],
): PageDrift {
  const issues: DriftIssue[] = []
  if (contract.fields === null) return { file: page.file, component: page.component, kind: page.kind, issues }
  const byName = new Map(contract.fields.map((f) => [f.name, f]))

  if (page.kind === 'list') {
    page.columns.forEach((column) => {
      const key = column.key
      const name = column.accessorKey ?? column.key
      if (key === null || name === null) return
      const field = byName.get(name)
      // Resolved when it is planned, where the column then is: not an index that may go stale.
      const rebuild: DriftFix = { label: `Rebuild column ${column.label ?? key} from the contract`, changes: [{ action: 'rebuild', column: key }] }
      // Only columns that read a field: an id-only column without an accessor (row actions) is
      // not about the contract.
      // Only a column with an accessor reads a field; an id-only one (row actions) does not.
      if (column.accessorKey === null) return
      if (!field) {
        issues.push({
          code: 'missing_field',
          name: key,
          message: `Column ${column.label ?? key} shows \`${name}\`, which the contract no longer has`,
          line: column.line,
          fix: { label: `Remove column ${column.label ?? key}`, changes: [{ action: 'remove', column: key }] },
        })
        return
      }
      // Its header's filter options, read by path: only a literal list gives a verdict.
      const options = sites.get(key)?.column
      const enumValues = field.enum ?? []
      if (field.shape === 'enum' && isReadable(options) && isStale(options, enumValues)) {
        const left = leftovers([options], enumValues, null, valueMentions)
        const align: DriftFix = { label: `Update the ${column.label ?? key} filter options from the contract`, changes: [{ action: 'align', column: key } satisfies ColumnChange] }
        issues.push({
          code: 'enum_changed',
          name: key,
          message: `Column ${column.label ?? key} filters on ${values(options).join(', ')}; the contract's values are ${enumValues.join(', ')}${left.suffix}`,
          line: column.line,
          // ⚑ Rebuilt only when the options can be read but not edited one by one.
          fix: options.state === 'blocked' ? rebuild : align,
          ...(left.references.length > 0 ? { references: left.references } : {}),
        })
        return
      }
      const expected = filterFor[field.shape]
      if (column.filter && expected && column.filter !== expected && !(field.shape === 'enum' && column.filter === 'DataTableFilterDropdownText')) {
        issues.push({
          code: 'type_changed',
          name: key,
          message: `Column ${column.label ?? key} uses ${column.filter}, but \`${name}\` is now ${describe(field)}`,
          line: column.line,
          fix: rebuild,
        })
      }
    })
    return { file: page.file, component: page.component, kind: 'list', issues }
  }

  // A form page.
  const rendered = page.fields.filter((f) => f.control !== null)
  for (const f of page.fields) {
    const field = byName.get(f.name)
    const index = rendered.findIndex((r) => r.name === f.name)
    const line = f.control?.line ?? null
    if (!field) {
      const references = leftover(f.name)
      const where = references.map((r) => r.line)
      issues.push({
        code: 'missing_field',
        name: f.name,
        message:
          `Field ${f.label ?? f.name} sends \`${f.name}\`, which the ${page.contract?.operation ?? 'request'} body no longer has` +
          (where.length > 0 ? `; the file still mentions it on ${where.length === 1 ? 'line' : 'lines'} ${where.join(', ')}` : ''),
        line,
        fix: { label: `Remove field ${f.label ?? f.name}`, changes: [{ action: 'remove', field: f.name }] },
        ...(references.length > 0 ? { references } : {}),
      })
      continue
    }
    const rebuild: DriftFix | null =
      index >= 0 ? { label: `Rebuild field ${f.label ?? f.name} from the contract`, changes: [{ action: 'rebuild', field: f.name } satisfies FieldChange] } : null
    const rule = f.rule ?? ''
    // The rule's first call, from its parsed chain when it has one: a chain written over several
    // lines (`z\n  .string()`) doesn't start with `z.string` as text.
    const base = f.ruleChain?.[0]
    const head = base ? `${base.name}(${base.args.join(', ')})` : rule
    const label = f.label ?? f.name
    // One in-place fix for the field: `align` settles its options, its default and its rule.
    let align: DriftFix | null = null
    const alignFix = (what: 'options' | 'rule'): DriftFix => ({ label: `Update the ${label} ${what} from the contract`, changes: [{ action: 'align', field: f.name } satisfies FieldChange] })
    if (field.shape === 'enum') {
      // The `z.enum([…])` array and the `<SelectItem>`s, each read whole: only literal lists give a verdict.
      const found = sites.get(f.name) ?? {}
      const enumValues = field.enum ?? []
      const stale = [found.rule, found.items].filter(isReadable).filter((site) => isStale(site, enumValues))
      if (stale.length > 0) {
        // ⚑ Rebuilt only when a stale list can be read but not edited one by one.
        const blocked = stale.some((site) => site.state === 'blocked')
        if (!blocked) align = alignFix('options')
        const left = leftovers(stale, enumValues, found.default ?? null, valueMentions)
        issues.push({
          code: 'enum_changed',
          name: f.name,
          message: `Field ${label} offers ${values(stale[0]!).join(', ')}; the contract's values are ${enumValues.join(', ')}${left.suffix}`,
          line,
          fix: blocked ? rebuild : align,
          ...(left.references.length > 0 ? { references: left.references } : {}),
        })
        if (blocked) continue
      }
    }
    if (rule && !ruleFamily[field.shape].test(head)) {
      issues.push({
        code: 'type_changed',
        name: f.name,
        message: `Field ${f.label ?? f.name} validates with \`${rule.slice(0, 40)}\`, but \`${f.name}\` is now ${describe(field)}`,
        line,
        fix: rebuild,
      })
      continue
    }
    // In place, by chain ops: the rest of the rule stays as written.
    const diff = ruleDiff(f.ruleChain, field)
    if (!hasDiff(diff)) continue
    // The same fix as the options' when they are stale too: one `align` settles all of it.
    align ??= alignFix('rule')
    if (diff.bounds.length > 0) {
      const changes = diff.bounds.map(({ bound, have }) => `${boundWords(bound.key, have?.args[0]?.trim() ?? null)} → ${boundWords(bound.key, bound.value)}`)
      issues.push({ code: 'constraint_changed', name: f.name, message: `Field ${label}'s rule has other bounds than the contract: ${changes.join(', ')}`, line: f.ruleLine ?? line, fix: align })
    }
    if (diff.optional || diff.nullable) {
      const what = [diff.optional ? 'leaves it out' : null, diff.nullable ? 'sends null' : null].filter(Boolean).join(' or ')
      const contractSays = [diff.optional ? 'requires it' : null, diff.nullable ? 'does not accept null' : null].filter(Boolean).join(' and ')
      issues.push({
        code: 'optionality_changed',
        name: f.name,
        message: `Field ${label} ${what} when empty, but the contract now ${contractSays}`,
        line: f.ruleLine ?? line,
        // The same fix as the bounds issue's: aligning the rule settles both.
        fix: align,
      })
    }
  }
  if (page.action === 'create') {
    const has = new Set(page.fields.map((f) => f.name))
    for (const name of contract.required) {
      const field = byName.get(name)
      if (has.has(name) || !field || field.readOnly) continue
      issues.push({
        code: 'required_missing',
        name,
        message: `The create body now requires \`${name}\` (${describe(field)}), which the form doesn't ask for`,
        line: null,
        fix: { label: `Add field ${name}`, changes: [{ action: 'add', field: name }] },
      })
    }
  }
  return { file: page.file, component: page.component, kind: 'form', issues }
}

/**
 * What a stale enum leaves behind once its options are aligned: the code that still names a
 * value the contract dropped (`=== "suspended"`, a lookup key), as a message suffix and as
 * `references`. The options themselves, and a default the fix rewrites, are not leftovers.
 */
function leftovers(
  stale: ReadableSite[],
  contract: string[],
  fallback: { value: string; line: number } | null,
  valueMentions: (removed: string[], own: Set<number>) => Array<{ value: string; references: References }>,
): { suffix: string; references: References } {
  const { removed, own } = removedValues(stale, contract, fallback)
  if (removed.length === 0) return { suffix: '', references: [] }
  const found = valueMentions(removed, own)
  const suffix = found
    .map(({ value, references }) => `"${value}" on ${references.length === 1 ? 'line' : 'lines'} ${references.map((r) => r.line).join(', ')}`)
    .join(' and ')
  const references = found
    .flatMap((f) => f.references)
    .filter((r, i, all) => all.findIndex((o) => o.line === r.line) === i)
    .sort((a, b) => a.line - b.line)
  return { suffix: suffix ? `; the file still names ${suffix}` : '', references }
}

function describe(field: FieldInfo): string {
  switch (field.shape) {
    case 'enum':
      return `an enum (${(field.enum ?? []).join(', ')})`
    case 'dateTime':
      return 'a date-time'
    case 'list':
      return 'a list'
    case 'other':
      return 'an object'
    default:
      return `a ${field.shape}`
  }
}
