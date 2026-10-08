// A Refine + shadcn list column for a contract field (docs/product.md, slice 1): the TanStack
// `ColumnDef` object refine-ui's DataTable renders, written the way Refine's own shadcn
// examples write it. The header sorts and filters by the field's type, and the cell renders it
// by type.

import type { ManifestField } from '@trivia/contract-sync'

/** One import a snippet needs (the engine's ImportSpec). */
export interface ImportSpec {
  name: string
  source: string
  default?: boolean
}

/** Where the project keeps the components a column uses. */
export interface ColumnContext {
  /** Module of shadcn's Badge, e.g. `@/components/ui/badge`. */
  badge: string
  /** Module prefix of refine-ui's data table, e.g. `@/components/refine-ui/data-table`; null when the project has none. */
  dataTable: string | null
}

export interface ColumnSnippet {
  /** The column object, as source text. */
  value: string
  imports: ImportSpec[]
}

/** How a field shows: what filter its header gets and how its cell renders. */
export type FieldShape = 'text' | 'enum' | 'number' | 'date' | 'dateTime' | 'boolean' | 'list' | 'other'

export function fieldShape(field: Pick<ManifestField, 'type' | 'format' | 'enum'>): FieldShape {
  if (field.enum && field.enum.some((v) => typeof v === 'string')) return 'enum'
  switch (field.type) {
    case 'string':
      if (field.format === 'date') return 'date'
      if (field.format === 'date-time') return 'dateTime'
      return 'text'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'array':
      return 'list'
    default:
      return 'other'
  }
}

/** `kycStatus` → `KYC status`, `createdAt` → `Created at`, `iban` → `IBAN`. */
export function humanize(name: string): string {
  const words = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
  const known: Record<string, string> = { id: 'ID', kyc: 'KYC', iban: 'IBAN', url: 'URL', api: 'API', vat: 'VAT', ssn: 'SSN', ip: 'IP' }
  return words
    .map((w, i) => {
      const lower = w.toLowerCase()
      if (known[lower]) return known[lower]
      if (/^[A-Z\d]{2,}$/.test(w)) return w
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join(' ')
}

/** `not_started` → `Not started`. */
function optionLabel(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const str = (s: string) => JSON.stringify(s)

/** The column for `field`, headed `label` (default: the humanized field name). */
/** What a column needs to know about its field. */
export type ColumnField = Pick<ManifestField, 'name' | 'type' | 'format' | 'enum' | 'required' | 'nullable'>

export function columnFor(field: ColumnField, context: ColumnContext, label = humanize(field.name)): ColumnSnippet {
  const shape = fieldShape(field)
  const imports = new Map<string, ImportSpec>()
  const use = (name: string, source: string) => imports.set(name, { name, source })
  const key = field.name
  const sortable = shape === 'text' || shape === 'number' || shape === 'date' || shape === 'dateTime'
  const lines: string[] = ['{', `  id: ${str(key)},`, `  accessorKey: ${str(key)},`]

  // The header: a label, a sorter, and a filter for the field's type (refine-ui's data table).
  const table = context.dataTable
  const filter: string[] = []
  if (table) {
    const filters = `${table}/data-table-filter`
    if (shape === 'text') {
      use('DataTableFilterDropdownText', filters)
      filter.push(
        '      <DataTableFilterDropdownText',
        '        defaultOperator="contains"',
        '        column={column}',
        '        table={table}',
        `        placeholder=${str(`Filter by ${label.toLowerCase()}`)}`,
        '      />',
      )
    } else if (shape === 'number') {
      use('DataTableFilterDropdownNumeric', filters)
      filter.push(
        '      <DataTableFilterDropdownNumeric',
        '        defaultOperator="eq"',
        '        column={column}',
        '        table={table}',
        `        placeholder=${str(`Filter by ${label.toLowerCase()}`)}`,
        '      />',
      )
    } else if (shape === 'enum') {
      use('DataTableFilterCombobox', filters)
      const options = (field.enum ?? []).filter((v): v is string => typeof v === 'string')
      filter.push(
        '      <DataTableFilterCombobox',
        '        column={column}',
        '        defaultOperator="in"',
        '        multiple',
        '        options={[',
        ...options.map((v) => `          { label: ${str(optionLabel(v))}, value: ${str(v)} },`),
        '        ]}',
        '      />',
      )
    } else if (shape === 'date' || shape === 'dateTime') {
      use('DataTableFilterDropdownDateRangePicker', filters)
      filter.push('      <DataTableFilterDropdownDateRangePicker column={column} />')
    }
  }
  const sorter = table !== null && sortable
  if (sorter) use('DataTableSorter', `${table}/data-table-sorter`)
  if (filter.length === 0 && !sorter) {
    lines.push(`  header: ${str(label)},`)
  } else {
    const params = filter.some((l) => l.includes('table={table}')) ? '{ column, table }' : '{ column }'
    lines.push(
      `  header: (${params}) => (`,
      '    <div className="flex items-center gap-1">',
      `      <span>${escapeJsxText(label)}</span>`,
      ...(sorter ? ['      <DataTableSorter column={column} />'] : []),
      ...filter,
      '    </div>',
      '  ),',
    )
  }
  if (!sortable) lines.push('  enableSorting: false,')

  // The cell, when the default (the raw value) would not read well.
  const nullable = field.nullable || !field.required
  const value = (type: string) => (nullable ? `getValue<${type} | null | undefined>()` : `getValue<${type}>()`)
  switch (shape) {
    case 'enum':
      use('Badge', context.badge)
      lines.push(
        nullable
          ? `  cell: ({ getValue }) => {\n    const value = ${value('string')};\n    return value ? <Badge variant="secondary">{value}</Badge> : "—";\n  },`
          : `  cell: ({ getValue }) => <Badge variant="secondary">{${value('string')}}</Badge>,`,
      )
      break
    case 'date':
    case 'dateTime': {
      const format = shape === 'date' ? 'toLocaleDateString' : 'toLocaleString'
      lines.push(
        nullable
          ? `  cell: ({ getValue }) => {\n    const value = ${value('string')};\n    return value ? new Date(value).${format}() : "—";\n  },`
          : `  cell: ({ getValue }) => new Date(${value('string')}).${format}(),`,
      )
      break
    }
    case 'number':
      lines.push(`  cell: ({ getValue }) => ${value('number')}${nullable ? '?.toLocaleString() ?? "—"' : '.toLocaleString()'},`)
      break
    case 'boolean':
      lines.push(`  cell: ({ getValue }) => (${value('boolean')} ? "Yes" : "No"),`)
      break
    case 'list':
      lines.push(`  cell: ({ getValue }) => (${value('unknown[]')} ?? []).join(", "),`)
      break
    case 'other':
      lines.push(`  cell: ({ getValue }) => JSON.stringify(${value('unknown')}),`)
      break
    default:
      break
  }
  lines.push('}')
  return { value: lines.join('\n'), imports: [...imports.values()] }
}

function escapeJsxText(text: string): string {
  return text.replace(/[{}<>]/g, (c) => `{${JSON.stringify(c)}}`)
}
