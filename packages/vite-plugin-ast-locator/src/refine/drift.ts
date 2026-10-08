// Contract drift (docs/product.md, slice 3): where a Refine page no longer matches the contract
// the manifest describes. Each issue says what is out of step and, when Trivia can fix it, the
// column or field changes that do (planned like any other: one undo entry).

import type { FieldChange, Page } from './index.js'
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
  /** For a removed form field: other code in the file that still names it (it breaks with the fix). */
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

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((v) => b.includes(v))
const quoted = (s: string) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!)

/**
 * The drift of each page against its contract. `entityFields` and `bodyFields` give the
 * contract fields a list page shows and a form page sends (null: the page matches no contract).
 * `sources` are the column header and Controller render sources, keyed by column key or field.
 */
export function pageDrift(
  page: Page,
  contract: { fields: FieldInfo[] | null; required: string[] },
  sources: Map<string, string>,
  /** Where a form's file still names a field outside the field itself. */
  leftover: (name: string) => Array<{ line: number; text: string }> = () => [],
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
      const header = sources.get(key) ?? ''
      // A cut-off excerpt (…) may hold only some of the options: no verdict from it.
      if (field.shape === 'enum' && column.filter === 'DataTableFilterCombobox' && !header.endsWith('…')) {
        const options = [...header.matchAll(/value:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!)
        if (options.length > 0 && !sameSet(options, field.enum ?? [])) {
          issues.push({
            code: 'enum_changed',
            name: key,
            message: `Column ${column.label ?? key} filters on ${options.join(', ')}; the contract's values are ${(field.enum ?? []).join(', ')}`,
            line: column.line,
            fix: rebuild,
          })
          return
        }
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
    if (field.shape === 'enum') {
      const ruleValues = /^z\.enum\(/.test(head) ? quoted(base ? (base.args[0] ?? '') : head.slice(0, head.indexOf(')') + 1)) : null
      const render = sources.get(f.name) ?? ''
      const items = [...render.matchAll(/<SelectItem\s+value="((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!)
      const stale = (ruleValues && !sameSet(ruleValues, field.enum ?? [])) || (items.length > 0 && !sameSet(items, field.enum ?? []))
      if (stale) {
        issues.push({
          code: 'enum_changed',
          name: f.name,
          message: `Field ${f.label ?? f.name} offers ${(ruleValues ?? items).join(', ')}; the contract's values are ${(field.enum ?? []).join(', ')}`,
          line,
          fix: rebuild,
        })
        continue
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
    const label = f.label ?? f.name
    const align: DriftFix = { label: `Update the ${label} rule from the contract`, changes: [{ action: 'align', field: f.name } satisfies FieldChange] }
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
