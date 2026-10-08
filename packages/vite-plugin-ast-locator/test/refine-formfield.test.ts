// Forms that survive real code (docs/product.md, slice 5) on a copy of examples/refine-admin:
// Refine's own `<FormField>` style, layout the developer chose (a grid, a guarded field),
// defaults passed in, and a schema-level `.refine`. Every edit keeps the untouched bytes.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { REFINE_ADMIN, copyRefineAdmin, get, post, startServer, type TestServer } from './helpers.js'

const EDIT = 'src/pages/customers/edit.tsx'
const NOTES = 'src/pages/customers/notes.tsx'

/** The user's day-1.5 fixture: generated once, then edited by hand. */
const NOTES_PAGE = `import { zodResolver } from "@hookform/resolvers/zod";
import type { HttpError } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import * as z from "zod";

import type { CustomerDto } from "@/api/generated/types.gen";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// A grid, a guarded field, a custom message, defaults passed in, a schema-level check.
const notesSchema = z
  .object({
    fullName: z.string().min(2, "Enter at least 2 characters."),
    creditLimit: z.number().min(0, "Enter 0 or more.").optional(),
    notes: z
      .string()
      .max(100, "Notes must be 100 characters or fewer")
      .nullable()
      .optional(),
  })
  .refine((values) => !values.notes?.includes("TODO"), {
    message: "Finish the notes first.",
    path: ["notes"],
  });

type NotesValues = z.infer<typeof notesSchema>;

export function CustomerNotes({ initial }: { initial?: Partial<NotesValues> }) {
  const {
    refineCore: { onFinish },
    ...form
  } = useForm<CustomerDto, HttpError, NotesValues>({
    resolver: zodResolver(notesSchema),
    defaultValues: {
      fullName: "",
      ...initial,
    },
    refineCoreProps: {
      resource: "customers",
      action: "edit",
    },
  });
  const showLimit = form.watch("fullName") !== "";

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onFinish)} className="grid gap-6">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="fullName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Full name</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        {showLimit && (
          <FormField
            control={form.control}
            name="creditLimit"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Credit limit</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="number"
                    value={field.value ?? ""}
                    onChange={(e) => field.onChange(e.target.value === "" ? undefined : e.target.valueAsNumber)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes</FormLabel>
              <FormControl>
                <Textarea {...field} value={field.value ?? ""} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">Save</Button>
      </form>
    </Form>
  );
}
`

let root: string
let server: TestServer
let original: string

beforeAll(async () => {
  root = copyRefineAdmin()
  fs.writeFileSync(path.join(root, NOTES), NOTES_PAGE)
  server = await startServer(root)
  original = fs.readFileSync(path.join(root, EDIT), 'utf8')
})

afterAll(async () => {
  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  fs.writeFileSync(path.join(root, EDIT), original)
  fs.writeFileSync(path.join(root, NOTES), NOTES_PAGE)
})

const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const form = async (file: string) => {
  const reply = await get(server.socket, `/refine/page?file=${encodeURIComponent(file)}`)
  expect(reply.status, JSON.stringify(reply.body)).toBe(200)
  return (reply.body.data as any[]).find((p) => p.kind === 'form')
}
const apply = async (file: string, changes: unknown[]) => {
  const planned = await post(server.socket, '/refine/fields/plan', { file, changes })
  expect(planned.status, JSON.stringify(planned.body)).toBe(200)
  const applied = await post(server.socket, '/batch', { ops: planned.body.data.ops, label: planned.body.data.label })
  expect(applied.status, JSON.stringify(applied.body)).toBe(200)
  return planned.body.data
}
const typecheck = () => {
  try {
    execFileSync(path.join(REFINE_ADMIN, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.app.json', '--noEmit'], { cwd: root, encoding: 'utf8' })
  } catch (error) {
    throw new Error(`the edited forms do not type-check:\n${(error as { stdout?: string }).stdout}`)
  }
}

/** True when `after` is `before` with whole lines added: every line of `before` is still there, unchanged and in order. */
function onlyAddsLines(before: string, after: string): string[] {
  const kept = before.split('\n')
  const added: string[] = []
  let i = 0
  for (const line of after.split('\n')) {
    if (i < kept.length && line === kept[i]) i += 1
    else added.push(line)
  }
  expect(i, `lines of the original changed or went missing (matched ${i} of ${kept.length})`).toBe(kept.length)
  return added
}

/** Where `name`'s control sits: its parent element, and whether it is under a `{…}` expression. */
const placeOf = (page: any, name: string) => {
  const control = page.fields.find((f: any) => f.name === name)?.control
  return control && { parent: control.parent?.name, direct: control.direct, element: control.element }
}

describe('Refine\'s FormField style', () => {
  it('reads a FormField form through a schema-level refine, with its layout', async () => {
    const p = await form(EDIT)
    expect(p).toMatchObject({ component: 'CustomerEdit', style: 'form', provider: true, schemaPath: `${EDIT}#module#customerSchema` })
    expect(p.fields.map((f: any) => [f.name, f.label, f.widget, f.rule?.slice(0, 12), placeOf(p, f.name)?.parent])).toEqual([
      ['fullName', 'Full name', 'Input', 'z.string().m', 'form'],
      ['email', 'Email', 'Input', 'z.email("Ent', 'form'],
      ['status', 'Status', 'Select', 'z.enum(["pen', 'div'],
      ['segment', 'Segment', 'Select', 'z.enum(["ret', 'div'],
    ])
    expect(p.fields[0].ruleChain).toEqual([
      { name: 'z.string', args: [] },
      { name: 'min', args: ['2', '"Enter at least 2 characters."'] },
    ])
  })

  it('adds a field in the form\'s style, after the field before it in the contract, inside its wrapper', async () => {
    // phone comes after email in the contract: after email, outside the grid.
    await apply(EDIT, [{ action: 'add', field: 'phone' }])
    // creditLimit comes after segment: inside the grid, after segment.
    await apply(EDIT, [{ action: 'add', field: 'creditLimit' }])
    const code = read(EDIT)
    const added = onlyAddsLines(original, code).join('\n')
    expect(added).toContain('<FormField\n')
    expect(added).not.toContain('Controller')
    expect(added).toContain('<FormLabel>Phone</FormLabel>')
    expect(code).toContain('    phone: z.string().nullable().optional(),\n    creditLimit: z.number().min(0, "Enter 0 or more.").optional(),\n  })\n  .refine(')
    const p = await form(EDIT)
    expect(p.fields.map((f: any) => `${f.name}@${placeOf(p, f.name)?.parent}`)).toEqual([
      'fullName@form',
      'email@form',
      'phone@form',
      'status@div',
      'segment@div',
      'creditLimit@div',
    ])
    typecheck()
  }, 120_000)

  it('plans several changes across wrappers in one entry, and undo restores every byte', async () => {
    const planned = await apply(EDIT, [
      { action: 'add', field: 'phone' },
      { action: 'add', field: 'creditLimit' },
      { action: 'rebuild', field: 'status' },
      { action: 'remove', field: 'email' },
      { action: 'move', field: 'fullName', index: 2 },
    ])
    expect(planned.label).toBe('Add field Phone; Add field Credit limit; Rebuild field Status; Remove field Email; Move field Full name')
    const p = await form(EDIT)
    expect(p.fields.map((f: any) => `${f.name}@${placeOf(p, f.name)?.parent}`)).toEqual([
      'phone@form',
      'status@div',
      'fullName@div',
      'segment@div',
      'creditLimit@div',
    ])
    typecheck()
    await post(server.socket, '/undo')
    expect(read(EDIT)).toBe(original)
  }, 120_000)

  it('writes a new resource\'s forms in the style most of the project\'s forms use', async () => {
    // Here two forms use FormField (edit, and the notes fixture) and one uses Field (create).
    expect((await form('src/pages/customers/create.tsx')).style).toBe('field')
    const planned = await post(server.socket, '/refine/pages/plan', { resource: 'Account', pages: ['create', 'edit'] })
    expect(planned.status, JSON.stringify(planned.body)).toBe(200)
    const applied = await post(server.socket, '/batch', { ops: planned.body.data.ops, label: planned.body.data.label })
    expect(applied.status, JSON.stringify(applied.body)).toBe(200)
    const create = read('src/pages/accounts/create.tsx')
    expect(create).toContain('      <Form {...form}>\n        <form\n')
    expect(create).toContain('          <FormField\n            control={form.control}\n            name="customerId"\n')
    expect(create).not.toMatch(/FieldGroup|Controller/)
    const page = await form('src/pages/accounts/edit.tsx')
    expect(page).toMatchObject({ style: 'form', provider: true })
    typecheck()
    await post(server.socket, '/undo')
    expect(fs.existsSync(path.join(root, 'src/pages/accounts/create.tsx'))).toBe(false)
  }, 120_000)
})

describe('a form edited by hand (the day-1.5 fixture)', () => {
  it('reads the guarded field as a field, but not one to anchor on', async () => {
    const p = await form(NOTES)
    expect(p).toMatchObject({ style: 'form', provider: true, schemaPath: `${NOTES}#module#notesSchema`, defaultsPath: `${NOTES}#CustomerNotes#useForm().defaultValues` })
    expect(p.fields.map((f: any) => [f.name, placeOf(p, f.name)])).toEqual([
      ['fullName', { parent: 'div', direct: true, element: 'FormField' }],
      ['creditLimit', { parent: 'form', direct: false, element: 'FormField' }],
      ['notes', { parent: 'form', direct: true, element: 'FormField' }],
    ])
  })

  it('adds a field without touching any other byte: never under the guard, and before the spread defaults', async () => {
    // birthDate's nearest field before it in the contract is creditLimit, which is guarded:
    // it goes after fullName instead, inside the grid.
    await apply(NOTES, [{ action: 'add', field: 'birthDate' }])
    const code = read(NOTES)
    const added = onlyAddsLines(NOTES_PAGE, code)
    expect(added[0]).toBe('    birthDate: z.iso.date("Enter a date.").nullable().optional(),')
    expect(added[1]).toBe('      birthDate: undefined,')
    expect(code).toContain('      fullName: "",\n      birthDate: undefined,\n      ...initial,\n')
    const grid = code.slice(code.indexOf('<div className="grid grid-cols-2 gap-4">'), code.indexOf('{showLimit && ('))
    expect(grid).toContain('name="birthDate"')
    expect(grid).toContain('type="date"')
    typecheck()
    await post(server.socket, '/undo')
    expect(read(NOTES)).toBe(NOTES_PAGE)
  }, 120_000)

  it('refuses to edit the guarded field, saying why', async () => {
    const planned = await post(server.socket, '/refine/fields/plan', { file: NOTES, changes: [{ action: 'remove', field: 'creditLimit' }] })
    expect(planned.status).toBe(200)
    const applied = await post(server.socket, '/batch', { ops: planned.body.data.ops, label: 'x' })
    expect(`${applied.status} ${applied.body.error?.code}: ${applied.body.error?.message}`).toMatch(/^422 unsupported: .*rendered from a \{…\} expression/)
    expect(read(NOTES)).toBe(NOTES_PAGE)
  })
})

describe('contract drift on hand-edited forms', () => {
  const drift = async () => {
    const reply = await get(server.socket, '/refine/drift')
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    return reply.body.data.pages as Array<{ file: string; component: string; kind: string; issues: any[] }>
  }
  const fix = async (page: { file: string; component: string }, issue: { fix: { label: string; changes: unknown[] } }) => {
    const planned = await post(server.socket, '/refine/fields/plan', { file: page.file, component: page.component, changes: issue.fix.changes })
    expect(planned.status, JSON.stringify(planned.body)).toBe(200)
    const applied = await post(server.socket, '/batch', { ops: planned.body.data.ops, label: issue.fix.label })
    expect(applied.status, JSON.stringify(applied.body)).toBe(200)
    return planned.body.data
  }
  const summary = (pages: Awaited<ReturnType<typeof drift>>) => pages.map((p) => `${p.component}: ${p.issues.map((i) => `${i.code} ${i.name}`).join(', ')}`)

  it('edits a bound in place: the custom message follows, the rest of the rule stays', async () => {
    // The fixture allows 100 characters of notes; the contract allows 1000.
    const pages = await drift()
    expect(summary(pages)).toEqual(['CustomerNotes: constraint_changed notes'])
    const issue = pages[0]!.issues[0]
    expect(issue).toMatchObject({
      message: 'Field Notes\'s rule has other bounds than the contract: max length 100 → max length 1000',
      line: 24,
      fix: { label: 'Update the Notes rule from the contract', changes: [{ action: 'align', field: 'notes' }] },
    })
    await fix(pages[0]!, issue)
    expect(read(NOTES)).toBe(NOTES_PAGE.replace('.max(100, "Notes must be 100 characters or fewer")', '.max(1000, "Notes must be 1000 characters or fewer")'))
    expect(await drift()).toEqual([])
    // A stale second click says so instead of writing nothing.
    const again = await post(server.socket, '/refine/fields/plan', { file: NOTES, changes: [{ action: 'align', field: 'notes' }] })
    expect(`${again.status} ${again.body.error.code}`).toBe('409 conflict')
  })

  it('after a spec change: bounds, required-ness and a removed field\'s other mentions', async () => {
    fs.writeFileSync(path.join(root, NOTES), NOTES_PAGE.replace('.max(100, "Notes must be 100 characters or fewer")', '.max(1000, "Notes must be 1000 characters or fewer")'))
    const specFile = path.join(root, 'openapi/bank.openapi.json')
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'))
    const schemas = spec.components.schemas
    for (const name of ['CustomerDto', 'CreateCustomerRequest', 'UpdateCustomerRequest']) schemas[name].properties.fullName = { type: 'string', minLength: 3, maxLength: 120 }
    schemas.UpdateCustomerRequest.required = ['creditLimit']
    delete schemas.UpdateCustomerRequest.properties.notes
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2))
    expect((await post(server.socket, '/sync', {})).status).toBe(200)

    const pages = await drift()
    expect(summary(pages)).toEqual([
      'CustomerCreate: constraint_changed fullName',
      'CustomerEdit: constraint_changed fullName',
      'CustomerNotes: constraint_changed fullName, optionality_changed creditLimit, missing_field notes',
    ])
    const notes = pages[2]!
    expect(notes.issues[0].message).toBe('Field Full name\'s rule has other bounds than the contract: min length 2 → min length 3, no max length → max length 120')
    expect(notes.issues[1].message).toBe('Field Credit limit leaves it out when empty, but the contract now requires it')
    expect(notes.issues[2].references).toEqual([
      { line: 30, text: '.refine((values) => !values.notes?.includes("TODO"), {' },
      { line: 32, text: 'path: ["notes"],' },
    ])
    expect(notes.issues[2].message).toMatch(/; the file still mentions it on lines 30, 32$/)

    // Fix the bounds and required-ness everywhere: in place, so everything else stays.
    for (const page of pages) for (const issue of page.issues.filter((i) => i.code !== 'missing_field')) await fix(page, issue)
    expect(read('src/pages/customers/create.tsx')).toContain('fullName: z.string().min(3, "Enter at least 3 characters.").max(120, "Enter at most 120 characters."),')
    expect(read(NOTES)).toContain('    creditLimit: z.number().min(0, "Enter 0 or more."),\n')
    expect(read(NOTES)).toContain('  .refine((values) => !values.notes?.includes("TODO"), {')
    expect(summary(await drift())).toEqual(['CustomerNotes: missing_field notes'])
    typecheck()

    // Removing the field says what still names it (tsc would say it too).
    const removed = await fix(notes, notes.issues[2])
    expect(removed.warnings).toEqual([
      `${NOTES} still mentions \`notes\` outside its field: line 30 (.refine((values) => !values.notes?.includes("TODO"), {); line 32 (path: ["notes"],)`,
    ])
  }, 180_000)
})
