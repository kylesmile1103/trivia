// A Refine + shadcn form field for a contract field (docs/product.md, slice 2): its zod rule,
// its default value, and a react-hook-form `Controller` around a shadcn `Field` (shadcn v4 has no
// `form` component; `Field` replaced it). The widget follows the field's type: a Select for an
// enum, a number input, a date input, a checkbox for a boolean, else a text input.

import type { ManifestField } from '@trivia/contract-sync'

import { type ImportSpec, escapeJsxText, fieldShape, humanize, optionLabel } from './columns.js'

export type FormField = Pick<ManifestField, 'name' | 'type' | 'format' | 'enum' | 'required' | 'nullable'> & { default?: unknown }

export interface FieldContext {
  /** Module prefix of shadcn's ui components, e.g. `@/components/ui`. */
  ui: string
  /** Prefix for the inputs' `id`s, e.g. `customer` → `customer-credit-limit`. */
  idPrefix: string
}

export interface FieldSnippet {
  /** The zod rule, e.g. `z.enum(["retail", "private"])`. */
  rule: string
  /** The default value, as source text. */
  defaultValue: string
  /** The `<Controller …/>` element. */
  controller: string
  imports: ImportSpec[]
}

const str = (s: string) => JSON.stringify(s)
export const kebab = (s: string) =>
  s
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z\d]+/g, '-')
    .toLowerCase()


function rule(field: FormField): string {
  const shape = fieldShape(field)
  const values = (field.enum ?? []).filter((v): v is string => typeof v === 'string')
  let base: string
  switch (shape) {
    case 'enum':
      base = `z.enum([${values.map(str).join(', ')}])`
      break
    case 'number':
      base = field.type === 'integer' ? 'z.number().int()' : 'z.number()'
      break
    case 'boolean':
      base = 'z.boolean()'
      break
    case 'date':
      base = 'z.iso.date("Enter a date.")'
      break
    case 'dateTime':
      base = 'z.iso.datetime("Enter a date and time.")'
      break
    case 'text':
      base =
        field.format === 'email'
          ? 'z.email("Enter an email address.")'
          : field.format === 'uuid'
            ? 'z.uuid()'
            : field.format === 'uri' || field.format === 'url'
              ? 'z.url("Enter a URL.")'
              : field.required
                ? 'z.string().min(1, "Required.")'
                : 'z.string()'
      break
    default:
      base = 'z.unknown()'
  }
  if (field.nullable) base += '.nullable()'
  if (!field.required) base += '.optional()'
  return base
}

function defaultValue(field: FormField): string {
  const shape = fieldShape(field)
  if (field.default !== undefined) return JSON.stringify(field.default)
  if (!field.required) return 'undefined'
  switch (shape) {
    case 'enum': {
      const first = (field.enum ?? []).find((v): v is string => typeof v === 'string')
      return first === undefined ? 'undefined' : str(first)
    }
    case 'number':
      return '0'
    case 'boolean':
      return 'false'
    case 'text':
    case 'date':
    case 'dateTime':
      return '""'
    default:
      return 'undefined'
  }
}

/** The pieces of a form field for `field`, labelled `label` (default: the humanized name). */
export function formFieldFor(field: FormField, context: FieldContext, label = humanize(field.name)): FieldSnippet {
  const shape = fieldShape(field)
  const id = `${context.idPrefix}-${kebab(field.name)}`
  const imports = new Map<string, ImportSpec>()
  const use = (name: string, source: string) => imports.set(name, { name, source })
  use('Controller', 'react-hook-form')
  for (const name of ['Field', 'FieldError', 'FieldLabel']) use(name, `${context.ui}/field`)

  // An optional text field left empty is absent, not "" (which a format check would refuse).
  const emptyIsAbsent = field.required ? '' : ' || undefined'
  let input: string[]
  if (shape === 'enum') {
    for (const name of ['Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue']) use(name, `${context.ui}/select`)
    const values = (field.enum ?? []).filter((v): v is string => typeof v === 'string')
    input = [
      `<Select value={field.value ?? ""} onValueChange={field.onChange}>`,
      `  <SelectTrigger id=${str(id)} aria-invalid={fieldState.invalid}>`,
      `    <SelectValue placeholder="Choose…" />`,
      `  </SelectTrigger>`,
      `  <SelectContent>`,
      ...values.map((v) => `    <SelectItem value=${str(v)}>${optionLabel(v)}</SelectItem>`),
      `  </SelectContent>`,
      `</Select>`,
    ]
  } else if (shape === 'boolean') {
    use('Checkbox', `${context.ui}/checkbox`)
    input = [
      `<Checkbox`,
      `  id=${str(id)}`,
      `  checked={field.value ?? false}`,
      `  onCheckedChange={(checked) => field.onChange(checked === true)}`,
      `/>`,
    ]
  } else if (shape === 'number') {
    use('Input', `${context.ui}/input`)
    input = [
      `<Input`,
      `  {...field}`,
      `  id=${str(id)}`,
      `  type="number"`,
      `  value={field.value ?? ""}`,
      `  onChange={(e) => field.onChange(e.target.value === "" ? undefined : e.target.valueAsNumber)}`,
      `  aria-invalid={fieldState.invalid}`,
      `/>`,
    ]
  } else {
    use('Input', `${context.ui}/input`)
    const type =
      field.format === 'email' ? 'email' : shape === 'date' ? 'date' : shape === 'dateTime' ? 'datetime-local' : field.format === 'uri' || field.format === 'url' ? 'url' : null
    input = [
      `<Input`,
      `  {...field}`,
      `  id=${str(id)}`,
      ...(type ? [`  type=${str(type)}`] : []),
      `  value={field.value ?? ""}`,
      `  onChange={(e) => field.onChange(e.target.value${emptyIsAbsent})}`,
      `  aria-invalid={fieldState.invalid}`,
      `/>`,
    ]
  }
  const controller = [
    `<Controller`,
    `  name=${str(field.name)}`,
    `  control={form.control}`,
    `  render={({ field, fieldState }) => (`,
    `    <Field data-invalid={fieldState.invalid}>`,
    `      <FieldLabel htmlFor=${str(id)}>${escapeJsxText(label)}</FieldLabel>`,
    ...input.map((line) => `      ${line}`),
    `      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}`,
    `    </Field>`,
    `  )}`,
    `/>`,
  ].join('\n')
  return { rule: rule(field), defaultValue: defaultValue(field), controller, imports: [...imports.values()] }
}
