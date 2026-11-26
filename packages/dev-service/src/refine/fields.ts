// A Refine + shadcn form field for a contract field (docs/product.md, slice 2): its zod rule,
// its default value, and its control: a react-hook-form `Controller` around a shadcn `Field`
// (shadcn v4), or shadcn's older `FormField` (Refine's docs and registry, slice 5). The widget follows the field's type: a Select for an
// enum, a number input, a date input, a checkbox for a boolean, a textarea for long text, else a
// text input. The rule carries the bounds the contract declares (slice 5).

import type { ManifestField, ManifestFieldConstraints } from '@trivia/contract-sync'

import { type ImportSpec, escapeJsxText, fieldShape, humanize, optionLabel } from './columns.js'

export type FormField = Pick<ManifestField, 'name' | 'type' | 'format' | 'enum' | 'required' | 'nullable'> & {
  default?: unknown
  constraints?: ManifestFieldConstraints | null
}

export interface FieldContext {
  /** Module prefix of shadcn's ui components, e.g. `@/components/ui`. */
  ui: string
  /** Prefix for the inputs' `id`s, e.g. `customer` → `customer-credit-limit`. */
  idPrefix: string
  /** The project has shadcn's `textarea` (long text gets one). */
  textarea?: boolean
  /** Use the installed Calendar and Popover for dates in kit forms. */
  datePicker?: boolean
  describeErrors?: boolean
  /**
   * How the form writes a field (docs/product.md, slice 5): `field` is a react-hook-form
   * `<Controller>` around shadcn's `Field` (v4); `form` is shadcn's older `<FormField>` with
   * `FormItem`/`FormLabel`/`FormControl`/`FormMessage`, as Refine's docs and registry write it.
   * Default `field`.
   */
  style?: FormStyle
}

export type FormStyle = 'field' | 'form'

/** Longest text a single-line input gets (⚑ docs/product.md, slice 5); longer gets a textarea. */
const TEXTAREA_OVER = 255

/** A bound the contract declares, as a call on the zod rule: `.max(100, "Enter at most 100 characters.")`. */
export interface Bound {
  key: keyof ManifestFieldConstraints
  method: 'min' | 'max' | 'gt' | 'lt' | 'regex'
  /** The bound argument's source: `100`, `new RegExp("^[A-Z]{3}$")`. */
  value: string
  /** The message Trivia writes with it. */
  message: string
}

/** The message Trivia writes for a bound (drift recognizes it to update it with the bound). */
export function boundMessage(key: Bound['key'], value: number | string): string {
  switch (key) {
    case 'minLength':
      return value === 1 ? 'Required.' : `Enter at least ${value} characters.`
    case 'maxLength':
      return `Enter at most ${value} characters.`
    case 'minimum':
      return `Enter ${value} or more.`
    case 'maximum':
      return `Enter ${value} or less.`
    case 'exclusiveMinimum':
      return `Enter more than ${value}.`
    case 'exclusiveMaximum':
      return `Enter less than ${value}.`
    case 'pattern':
      return 'Enter a value in the expected format.'
  }
}

/** Source text for a pattern's RegExp, or null when JavaScript can't compile it. */
export function patternSource(pattern: string): string | null {
  try {
    new RegExp(pattern)
  } catch {
    return null
  }
  return `new RegExp(${JSON.stringify(pattern)})`
}

/** The bounds of `field` its rule should carry, in the order they are written. */
export function boundsOf(field: FormField): Bound[] {
  const c = field.constraints ?? {}
  const out: Bound[] = []
  const add = (key: Bound['key'], method: Bound['method'], value: number | undefined) => {
    if (value !== undefined) out.push({ key, method, value: String(value), message: boundMessage(key, value) })
  }
  const shape = fieldShape(field)
  if (shape === 'text') {
    add('minLength', 'min', c.minLength)
    add('maxLength', 'max', c.maxLength)
    const regex = c.pattern === undefined ? null : patternSource(c.pattern)
    if (regex) out.push({ key: 'pattern', method: 'regex', value: regex, message: boundMessage('pattern', c.pattern!) })
  } else if (shape === 'number') {
    add('minimum', 'min', c.minimum)
    add('exclusiveMinimum', 'gt', c.exclusiveMinimum)
    add('maximum', 'max', c.maximum)
    add('exclusiveMaximum', 'lt', c.exclusiveMaximum)
  }
  return out
}

/** True when `field` gets a textarea in a project that has one. */
export function isLongText(field: FormField): boolean {
  return fieldShape(field) === 'text' && !TEXT_FORMATS.has(field.format ?? '') && (field.constraints?.maxLength ?? 0) > TEXTAREA_OVER
}

/** String formats with an input of their own (or a zod check that rules out long text). */
const TEXT_FORMATS = new Set(['email', 'uuid', 'uri', 'url', 'password'])

export interface FieldSnippet {
  /** The zod rule, e.g. `z.enum(["retail", "private"])`. */
  rule: string
  /** The default value, as source text. */
  defaultValue: string
  /** The `<Controller …/>` or `<FormField …/>` element. */
  controller: string
  /** Its tag: `Controller` or `FormField`. */
  element: 'Controller' | 'FormField'
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
    case 'text': {
      const declaresMin = field.constraints?.minLength !== undefined
      base =
        field.format === 'email'
          ? 'z.email("Enter an email address.")'
          : field.format === 'uuid'
            ? 'z.uuid()'
            : field.format === 'uri' || field.format === 'url'
              ? 'z.url("Enter a URL.")'
              : field.required && !declaresMin
                ? 'z.string().min(1, "Required.")'
                : 'z.string()'
      break
    }
    default:
      base = 'z.unknown()'
  }
  for (const b of boundsOf(field)) base += `.${b.method}(${b.value}, ${str(b.message)})`
  if (field.nullable) base += '.nullable()'
  if (!field.required) base += '.optional()'
  return base
}

/** The default a new field gets in `defaultValues`, as source text (an `align` also writes it over a removed enum value). */
export function defaultValue(field: FormField): string {
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
  const style = context.style ?? 'field'
  const id = `${context.idPrefix}-${kebab(field.name)}`
  const imports = new Map<string, ImportSpec>()
  const use = (name: string, source: string) => imports.set(name, { name, source })
  if (style === 'field') {
    use('Controller', 'react-hook-form')
    for (const name of ['Field', 'FieldError', 'FieldLabel']) use(name, `${context.ui}/field`)
  } else {
    for (const name of ['FormControl', 'FormField', 'FormItem', 'FormLabel', 'FormMessage']) use(name, `${context.ui}/form`)
  }
  // `Field` wires the label and the error state by hand; `FormControl` does it from context.
  const wired = style === 'field' ? [`  id=${str(id)}`] : []
  const errorId = str(id + '-error')
  const describe = context.describeErrors && style === 'field'
    ? [`aria-describedby={fieldState.invalid ? ${errorId} : undefined}`, ...(field.required ? ['aria-required'] : [])]
    : []
  const invalid = style === 'field' ? ['  aria-invalid={fieldState.invalid}', ...describe.map((prop) => '  ' + prop)] : []
  /** `lines` as the control: inside `<FormControl>` in the `form` style. */
  const formControl = context.describeErrors && field.required ? '<FormControl aria-required>' : '<FormControl>'
  const control = (lines: string[]) => (style === 'field' ? lines : [formControl, ...lines.map((l) => `  ${l}`), '</FormControl>'])

  // An optional text field left empty is absent, not "" (which a format check would refuse).
  const emptyIsAbsent = field.required ? '' : ' || undefined'
  let input: string[]
  if (shape === 'enum') {
    for (const name of ['Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue']) use(name, `${context.ui}/select`)
    const values = (field.enum ?? []).filter((v): v is string => typeof v === 'string')
    const trigger = style === 'field' ? `<SelectTrigger id=${str(id)} aria-invalid={fieldState.invalid}${describe.length ? ' ' + describe.join(' ') : ''}>` : '<SelectTrigger>'
    input = [
      `<Select value={field.value ?? ""} onValueChange={field.onChange}>`,
      ...control([trigger, `  <SelectValue placeholder="Choose…" />`, `</SelectTrigger>`]).map((l) => `  ${l}`),
      `  <SelectContent>`,
      ...values.map((v) => `    <SelectItem value=${str(v)}>${optionLabel(v)}</SelectItem>`),
      `  </SelectContent>`,
      `</Select>`,
    ]
  } else if (shape === 'boolean') {
    use('Checkbox', `${context.ui}/checkbox`)
    input = control([`<Checkbox`, ...wired, `  checked={field.value ?? false}`, `  onCheckedChange={(checked) => field.onChange(checked === true)}`,
      ...(context.describeErrors ? invalid : []), `/>`])
  } else if (shape === 'number') {
    use('Input', `${context.ui}/input`)
    input = control([
      `<Input`,
      `  {...field}`,
      ...wired,
      `  type="number"`,
      `  value={field.value ?? ""}`,
      `  onChange={(e) => field.onChange(e.target.value === "" ? undefined : e.target.valueAsNumber)}`,
      ...invalid,
      `/>`,
    ])
  } else if (shape === 'date' && context.datePicker) {
    use('Calendar', `${context.ui}/calendar`)
    for (const part of ['Popover', 'PopoverContent', 'PopoverTrigger']) use(part, `${context.ui}/popover`)
    use('format', 'date-fns')
    const cleared = field.nullable ? 'null' : field.required ? '""' : 'undefined'
    input = [
      '<Popover>',
      ...control(['<PopoverTrigger type="button"', ...wired, ...invalid, '>', '  {field.value || "Pick a date"}', '</PopoverTrigger>'])
        .map((line) => '  ' + line),
      '  <PopoverContent>',
      '    <Calendar',
      '      mode="single"',
      '      selected={field.value ? new Date(field.value + "T00:00:00") : undefined}',
      `      onSelect={(date) => field.onChange(date ? format(date, "yyyy-MM-dd") : ${cleared})}`,
      '    />',
      '  </PopoverContent>',
      '</Popover>',
    ]
  } else if (context.textarea && isLongText(field)) {
    use('Textarea', `${context.ui}/textarea`)
    input = control([
      `<Textarea`,
      `  {...field}`,
      ...wired,
      `  value={field.value ?? ""}`,
      `  onChange={(e) => field.onChange(e.target.value${emptyIsAbsent})}`,
      ...invalid,
      `/>`,
    ])
  } else {
    use('Input', `${context.ui}/input`)
    const type =
      field.format === 'email'
        ? 'email'
        : field.format === 'password'
          ? 'password'
          : shape === 'date'
            ? 'date'
            : shape === 'dateTime'
              ? 'datetime-local'
              : field.format === 'uri' || field.format === 'url'
                ? 'url'
                : null
    input = control([
      `<Input`,
      `  {...field}`,
      ...wired,
      ...(type ? [`  type=${str(type)}`] : []),
      `  value={field.value ?? ""}`,
      `  onChange={(e) => field.onChange(e.target.value${emptyIsAbsent})}`,
      ...invalid,
      `/>`,
    ])
  }
  const controller =
    style === 'field'
      ? [
          `<Controller`,
          `  name=${str(field.name)}`,
          `  control={form.control}`,
          `  render={({ field, fieldState }) => (`,
          `    <Field data-invalid={fieldState.invalid}>`,
          `      <FieldLabel htmlFor=${str(id)}>${escapeJsxText(label)}</FieldLabel>`,
          ...input.map((line) => `      ${line}`),
          `      {fieldState.invalid && <FieldError${context.describeErrors ? ' id=' + errorId : ''} errors={[fieldState.error]} />}`,
          `    </Field>`,
          `  )}`,
          `/>`,
        ]
      : [
          `<FormField`,
          `  control={form.control}`,
          `  name=${str(field.name)}`,
          `  render={({ field }) => (`,
          `    <FormItem>`,
          `      <FormLabel>${escapeJsxText(label)}</FormLabel>`,
          ...input.map((line) => `      ${line}`),
          `      <FormMessage />`,
          `    </FormItem>`,
          `  )}`,
          `/>`,
        ]
  return { rule: rule(field), defaultValue: defaultValue(field), controller: controller.join('\n'), element: style === 'field' ? 'Controller' : 'FormField', imports: [...imports.values()] }
}
