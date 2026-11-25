// The MCP tools (docs/mcp.md): point-and-ask. The user selects an element in the designer and
// tells an agent what to change; the agent reads the selection and applies guarded ops. Every
// tool calls EngineService, so agent edits share the designer's queue and undo history.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { EngineService } from '../api/service.js'
import { ApiError } from '../engine.js'
import { type ListPage, parseColumnChanges, parseFieldChanges } from '../refine/index.js'
import type { ErrorCode } from '../types.js'

/** Every agent edit's history label starts with this, so the designer's undo menu says whose it is. */
export const AGENT_LABEL = 'Agent: '

interface Node {
  locator: string
  name: string
  [key: string]: unknown
}

interface OutlineNode {
  locator: string
  name: string
  text?: string
  children: OutlineNode[]
}

interface Component {
  name: string
  importSource: string
  acceptsChildren: boolean
  props: unknown[]
  [key: string]: unknown
}

// ---------------------------------------------------------------------------------------------
// Op schemas: docs/api.md, with every stale-locator guard required.

const locator = z.string().describe('A locator from trivia_get_selection or trivia_inspect: `<file>#<component>#<i.j.k>`')
const guard = (what: string) =>
  z
    .string()
    .min(1)
    .describe(`The tag name at ${what} as trivia_get_selection or trivia_inspect reported it (e.g. "Button"); the edit is refused if the file changed and it now names another element`)
const placement = z.enum(['before', 'after', 'firstChild', 'lastChild'])
const snippet = z
  .string()
  .min(1)
  .describe('Exactly one JSX element, unindented, e.g. `<Badge variant="secondary">New</Badge>`; the engine indents it')
const imports = z
  .array(z.object({ name: z.string(), source: z.string(), default: z.boolean().optional() }).strict())
  .default([])
  .describe('Imports the snippet needs, e.g. [{ "name": "Badge", "source": "@/components/ui/badge" }] (trivia_list_components gives importSource)')
const json = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
const valuePath = z
  .string()
  .describe('A value path from trivia_get_page (a columnsPath, a column\'s path): `<file>#<scope>#<binding or call()>[.prop][[key=value]][[i]]`')
const valueText = z
  .string()
  .min(1)
  .describe('One JS/TSX expression as source text, unindented, e.g. `{ id: "email", accessorKey: "email", header: "Email" }`; the engine indents it')

const op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('updateProp'), target: locator, expectedName: guard('target'), prop: z.string().min(1), value: json.describe('The new value; null removes the prop') }).strict(),
  z.object({ op: z.literal('setText'), target: locator, expectedName: guard('target'), text: z.string().describe('The text it renders; plain text only') }).strict(),
  z.object({ op: z.literal('insert'), target: locator, expectedName: guard('target'), placement, snippet, imports }).strict(),
  z.object({ op: z.literal('insertChild'), parent: locator, expectedName: guard('parent'), index: z.number().int().min(0), snippet, imports }).strict(),
  z.object({ op: z.literal('remove'), target: locator, expectedName: guard('target') }).strict(),
  z
    .object({ op: z.literal('replaceElement'), target: locator, expectedName: guard('target'), snippet: snippet.describe('The element that takes its place, e.g. `<CustomerList />`'), imports })
    .strict(),
  z.object({ op: z.literal('move'), source: locator, expectedName: guard('source'), target: locator, expectedTargetName: guard('target'), placement }).strict(),
  z.object({ op: z.literal('moveNode'), source: locator, expectedName: guard('source'), parent: locator, expectedParentName: guard('parent'), index: z.number().int().min(0) }).strict(),
  z
    .object({
      op: z.literal('createFile'),
      file: z.string().min(1).describe('Project-relative path of a new .tsx/.jsx file, e.g. "src/components/customer-card.tsx"'),
      content: z.string().min(1).describe('Its full source; it must parse. Never overwrites an existing file'),
      ifMissing: z.boolean().optional().describe('true: an existing file is kept as it is (a no-op) instead of refused'),
    })
    .strict(),
  z
    .object({
      op: z.literal('bindQuery'),
      target: locator,
      expectedName: guard('target'),
      optionsFn: z.string().min(1).describe('The generated TanStack options factory, e.g. "listCustomersOptions" (trivia.manifest.json)'),
      optionsImport: z.string().min(1).describe('The module exporting it, e.g. "@/api/generated/@tanstack/react-query.gen"'),
      optionsArgs: z.string().optional().describe('The factory\'s argument as JS expression text, e.g. "{ query: { page: 1 } }"'),
      resource: z.string().min(1).describe('Resource name for the variables: "Customer" → customerData, isCustomerLoading'),
      itemsPath: z.string().optional().describe('Path to the rows in the response ("items" → data?.items ?? []); omit when the response is the array'),
      dataProp: z.string().min(1).describe('Prop that receives the rows, usually "data"'),
      loadingProp: z.string().optional().describe('Prop that receives the loading flag, usually "isLoading"'),
    })
    .strict(),
  z.object({ op: z.literal('insertElement'), path: valuePath, index: z.number().int().min(0).optional().describe('Before this element; omit to append'), value: valueText, imports }).strict(),
  z.object({ op: z.literal('removeElement'), path: valuePath.describe('The element to remove, by key: `…#columns[id=email]`') }).strict(),
  z.object({ op: z.literal('moveElement'), path: valuePath.describe('The element to move, by key: `…#columns[id=email]`'), index: z.number().int().min(0).describe('Its position after the move') }).strict(),
  z.object({ op: z.literal('setProperty'), path: valuePath.describe('An object literal, e.g. a column `…#columns[id=email]`'), prop: z.string().min(1), value: valueText, imports }).strict(),
  z.object({ op: z.literal('removeProperty'), path: valuePath.describe('An object literal'), prop: z.string().min(1) }).strict(),
  z
    .object({
      op: z.literal('setCallArgument'),
      path: valuePath.describe('A method chain, e.g. a zod rule `…#module#customerSchema.notes`'),
      method: z.string().min(1).describe('The call: a method (`max`), or the first call by its callee (`z.enum`)'),
      index: z.number().int().min(0).describe('The argument; the argument count appends one'),
      value: valueText,
    })
    .strict(),
  z
    .object({
      op: z.literal('insertCall'),
      path: valuePath.describe('A method chain, e.g. a zod rule'),
      call: z.string().min(1).describe('One method call, e.g. `max(500, "At most 500 characters.")`'),
      before: z.array(z.string().min(1)).optional().describe('Goes before the first call with one of these methods, e.g. ["optional", "refine"]; default: at the end'),
    })
    .strict(),
  z.object({ op: z.literal('removeCall'), path: valuePath.describe('A method chain, e.g. a zod rule'), method: z.string().min(1).describe('The method to drop, e.g. `optional`') }).strict(),
])

const fieldChange = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('add'),
      field: z.string().min(1).describe('A request-body field the form does not have yet (trivia_get_page: available)'),
      index: z.number().int().min(0).optional().describe('Before this field; omit to append'),
      label: z.string().min(1).optional().describe('The label; default: the field name, humanized'),
    })
    .strict(),
  z.object({ action: z.literal('remove'), field: z.string().min(1) }).strict(),
  z.object({ action: z.literal('move'), field: z.string().min(1), index: z.number().int().min(0).describe('Its position after the move') }).strict(),
  z.object({ action: z.literal('rebuild'), field: z.string().min(1).describe('Re-generate it from the contract where it is (trivia_contract_drift fixes)') }).strict(),
  z
    .object({
      action: z.literal('align'),
      field: z.string().min(1).describe('Edit its zod rule in place to the contract\'s bounds and required-ness, keeping the rest (trivia_contract_drift fixes)'),
    })
    .strict(),
])

const columnChange = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('add'),
      field: z.string().min(1).describe('A contract field the page does not show yet (trivia_get_page: available)'),
      index: z.number().int().min(0).optional().describe('Before this column; omit to append'),
      label: z.string().min(1).optional().describe('The header text; default: the field name, humanized'),
    })
    .strict(),
  z.object({ action: z.literal('remove'), column: z.string().min(1).describe('The column key (trivia_get_page: columns[].key)') }).strict(),
  z.object({ action: z.literal('move'), column: z.string().min(1), index: z.number().int().min(0).describe('Its position after the move') }).strict(),
  z.object({ action: z.literal('rebuild'), column: z.string().min(1).describe('Re-generate it from the contract where it is (trivia_contract_drift fixes)') }).strict(),
])

// ---------------------------------------------------------------------------------------------

/** What to do next after each kind of refusal, for the agent. */
/** A stale selection: reading it again changes nothing until the user selects again. */
const RESELECT: Partial<Record<ErrorCode, string>> = {
  stale_locator:
    'The file was edited since the user selected this, so the selection is out of date. Ask the user to select the ' +
    'element again; trivia_get_selection keeps failing until they do.',
  node_not_found: 'The selected element is gone from the file. Ask the user to select the element again.',
}

const NEXT: Partial<Record<ErrorCode, string>> = {
  stale_locator: 'The file changed since you read it: call trivia_get_selection (or trivia_inspect) again and retry with what it returns.',
  node_not_found: 'The file changed since you read it: call trivia_get_selection (or trivia_inspect) again and retry with what it returns.',
  conflict: 'The file changed on disk meanwhile: read it again before retrying.',
  unsupported: 'The engine cannot make this edit; tell the user, or edit the file directly (that edit will not be in Trivia\'s undo history).',
  invalid_snippet: 'Send exactly one JSX element, without surrounding parentheses or comments.',
  unresolved_component: 'Pass an import for the component (trivia_list_components gives its importSource).',
}

export function registerTools(server: McpServer, service: EngineService, log: (message: string) => void): void {
  /**
   * Run a tool body; engine refusals become tool errors the agent can act on. `next` replaces
   * NEXT's advice for codes that mean something else from this tool.
   */
  const run = async (
    body: () => Promise<{ data: Record<string, unknown>; summary: string }>,
    next: Partial<Record<ErrorCode, string>> = {},
  ): Promise<CallToolResult> => {
    try {
      const { data, summary } = await body()
      return { content: [{ type: 'text', text: `${summary}\n${JSON.stringify(data, null, 2)}` }], structuredContent: data }
    } catch (error) {
      if (error instanceof ApiError) {
        const advice = next[error.code] ?? NEXT[error.code]
        return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}${advice ? `\n${advice}` : ''}` }] }
      }
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      log(`[trivia] MCP tool failed: ${detail}`)
      return { isError: true, content: [{ type: 'text', text: `internal: ${error instanceof Error ? error.message : String(error)}` }] }
    }
  }

  /** The component schema for a library element, or null for intrinsic elements and others. */
  const componentOf = (name: string): Component | null =>
    (service.components() as Component[]).find((c) => c.name === name) ?? null

  const describeNode = (at: string) => {
    const node = service.inspect(at) as Node
    return { ...node, component: componentOf(node.name) }
  }

  const reads = { readOnlyHint: true, openWorldHint: false } as const

  server.registerTool(
    'trivia_get_selection',
    {
      title: 'Get the designer selection',
      description:
        'What the user has selected on the Trivia canvas: the element\'s locator, tag name, file and line, attributes, ' +
        'text, parent and children, and, for components from the user\'s library, the props it takes (with enum options). ' +
        'Call this first when the user says "this", "the selected …" or "here". Pass its locator and name to trivia_apply. ' +
        'Also returns the shared undo history (history.undoLabel is what trivia_undo would undo next).',
      annotations: reads,
    },
    () =>
      run(async () => {
        const { selection } = service.selection()
        const history = service.history()
        if (selection === null) {
          // Clients such as Claude Code show the agent structuredContent, not the summary.
          const hint = 'Nothing is selected in the Trivia designer. Ask the user to select an element on the canvas.'
          return { data: { selection: null, hint, history }, summary: hint }
        }
        const node = describeNode(selection.locator)
        if (node.name !== selection.name) {
          throw new ApiError(
            'stale_locator',
            `the selection was <${selection.name}> but ${selection.locator} now holds <${node.name}>; ask the user to select it again`,
          )
        }
        return { data: { selection: node, history }, summary: `Selected: <${node.name}> at ${node.locator}` }
      }, RESELECT),
  )

  server.registerTool(
    'trivia_inspect',
    {
      title: 'Inspect an element',
      description:
        'Details of the element at a locator, as trivia_get_selection gives them for the selection. Use the parent and ' +
        'children locators it returns to look around the selection.',
      inputSchema: { locator },
      annotations: reads,
    },
    ({ locator: at }) =>
      run(async () => {
        const node = describeNode(at)
        return { data: { node }, summary: `<${node.name}> at ${node.locator}` }
      }),
  )

  server.registerTool(
    'trivia_outline',
    {
      title: 'Outline a file',
      description:
        'Every JSX tree of a project file (e.g. the file trivia_get_selection names): each element\'s locator, tag ' +
        'name, line, plain text and children. Use it to find an element the user describes in words.',
      inputSchema: { file: z.string().min(1).describe('Project-relative path, e.g. "src/pages/Dashboard.tsx"') },
      annotations: reads,
    },
    ({ file }) =>
      run(async () => {
        const trees = service.outline(file) as OutlineNode[]
        const lines: string[] = []
        const walk = (node: OutlineNode, depth: number) => {
          lines.push(`${'  '.repeat(depth)}<${node.name}>${node.text ? ` ${node.text}` : ''}  ${node.locator}`)
          for (const child of node.children) walk(child, depth + 1)
        }
        for (const tree of trees) walk(tree, 0)
        return { data: { trees }, summary: lines.join('\n') || `${file} has no JSX.` }
      }),
  )

  server.registerTool(
    'trivia_list_routes',
    {
      title: 'List the app\'s routes',
      description:
        'Every page a URL reaches, read from the source (React Router <Route>s and route objects, nested <Routes> ' +
        'joined onto their parent, TanStack Router file and code routes): its URL pattern and params, the component ' +
        'it renders and that component\'s file, where the route is declared, and in a Refine app the resource and ' +
        'action. Use it to find the file of the page the user names ("the edit page"), or a route\'s <Route> element.',
      annotations: reads,
    },
    () =>
      run(async () => {
        const routes = await service.routes()
        const lines = routes.map((r) => {
          const label = r.resource ? ` (${r.resource.name} ${r.resource.action})` : ''
          return `${r.path}${label}  <${r.component ?? 'lazy'}> ${r.file ?? '(module not resolved)'}`
        })
        return { data: { routes }, summary: lines.join('\n') || 'No routes found: the app has no React Router or TanStack Router routes under src/.' }
      }),
  )

  server.registerTool(
    'trivia_list_components',
    {
      title: 'List the component library',
      description:
        'The user\'s components (their src/components/ui): each one\'s name, importSource (for trivia_apply imports), ' +
        'whether it takes children, and its props with their kinds, enum options and defaults.',
      annotations: reads,
    },
    () =>
      run(async () => {
        const components = (service.components() as Component[]).map(({ name, importSource, acceptsChildren, props }) => ({
          name,
          importSource,
          acceptsChildren,
          props,
        }))
        return { data: { components }, summary: `${components.length} components` }
      }),
  )

  server.registerTool(
    'trivia_apply',
    {
      title: 'Edit the code',
      description:
        'Apply one or more guarded edits to the user\'s source files, byte for byte (formatting and comments are kept), ' +
        'as one entry in the designer\'s undo history. Ops: updateProp (value null removes it), setText, insert, ' +
        'insertChild, remove, replaceElement (one element for another where it stands, also inside element={…}), move (also to another file: its imports come along), moveNode, bindQuery (a TanStack Query ' +
        'hook feeding the element, docs/data-provider.md) and createFile (a new component file; undo deletes it); and, ' +
        'for object and array literals addressed by value path (Refine columns, zod schemas, defaultValues), ' +
        'insertElement, removeElement, moveElement, setProperty and removeProperty; and for one call of a method chain ' +
        '(a zod rule: `z.string().max(100, "…").optional()`), setCallArgument, insertCall and removeCall, which keep the ' +
        'other calls and messages as written. ' +
        'Each names elements by locator and must carry the tag name you read there ' +
        '(expectedName, and expectedTargetName / expectedParentName for the other element): the edit is refused instead ' +
        'of hitting the wrong element when the file changed. Several ops: each op\'s locators must hold after the ops ' +
        'before it (an insert or remove shifts the indices of later siblings). The result gives the edited element\'s ' +
        'new locator and the selection, which follows the element it was on.',
      inputSchema: {
        ops: z.array(op).min(1),
        label: z.string().min(1).describe('A few words for the undo menu, e.g. "Make Save outline"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ ops, label }) =>
      run(async () => {
        const entry = `${AGENT_LABEL}${label.trim()}`
        const [only] = ops
        const result =
          ops.length === 1 && only ? await service.apply(only, entry, { by: 'agent' }) : await service.batch(ops, entry, { by: 'agent' })
        const data = { ...result, selection: service.selection() }
        return {
          data,
          summary: result.changed ? `Applied "${entry}" to ${result.file}.` : `Nothing changed: ${result.file} already reads that way.`,
        }
      }),
  )

  server.registerTool(
    'trivia_get_page',
    {
      title: 'Read a Refine page',
      description:
        'The Refine pages of a file. A list page (a component calling useTable) has its columns as the source has them ' +
        '(key, header label, filter, the contract field it shows); a form page (useForm with a zodResolver) has its fields ' +
        '(label, widget, zod rule). Each lists the contract fields it does not have yet (available, with type and enum ' +
        'values from the OpenAPI contract). Without a file, the selected element\'s file; with neither, every page in src/ ' +
        'and each contract resource with the pages it has and could have (for trivia_add_pages). ' +
        'Use it before trivia_edit_columns, trivia_edit_fields or trivia_add_pages.',
      inputSchema: { file: z.string().min(1).optional().describe('Project-relative file, e.g. "src/pages/customers/list.tsx"') },
      annotations: reads,
    },
    ({ file }) =>
      run(async () => {
        const selected = service.selection().selection?.locator.split('#')[0]
        const target = file ?? selected
        const pages = target ? await service.refine.page(target) : await service.refine.pages()
        const resources = target ? undefined : await service.refine.resources()
        const hint =
          pages.length === 0
            ? `${target ?? 'src/'} has no Refine list page (a component calling useTable from @refinedev/react-table).`
            : null
        return {
          data: { file: target ?? null, pages, ...(resources ? { resources } : {}), ...(hint ? { hint } : {}) },
          summary:
            hint ??
            pages
              .map((p) =>
                p.kind === 'list'
                  ? `${p.component} (${p.file}), list: ${p.columns.map((c) => c.key).join(', ')}`
                  : `${p.component} (${p.file}), ${p.action ?? ''} form: ${p.fields.map((f) => f.name).join(', ')}`,
              )
              .join('\n'),
        }
      }),
  )

  server.registerTool(
    'trivia_contract_drift',
    {
      title: 'Check pages against the contract',
      description:
        'Where the Refine pages no longer match the OpenAPI contract (trivia.manifest.json): a column or field for a ' +
        'field the contract dropped (with `references`: other lines that still name it), enum values or a type that ' +
        'changed, bounds (minLength, maxLength, minimum…) that differ, a rule that is optional where the contract now ' +
        'requires the field, a field a create body now requires. Each issue has a fix: pass fix.changes to trivia_edit_columns (list pages) or trivia_edit_fields (forms), one ' +
        'issue at a time, reading this again in between. spec.status "changed" means the spec file changed since the ' +
        'last sync: run trivia_sync_openapi first.',
      annotations: reads,
    },
    () =>
      run(async () => {
        const d = await service.refine.drift()
        const count = d.pages.reduce((n, p) => n + p.issues.length, 0)
        const specChanged = (d.spec as { status?: string } | null)?.status === 'changed'
        const note = specChanged ? 'The spec changed since the last sync: run trivia_sync_openapi first.' : null
        return {
          data: { ...d, ...(note ? { note } : {}) },
          summary:
            (note ? `${note}\n` : '') +
            (count === 0
              ? 'Every Refine page matches the contract.'
              : d.pages.map((p) => `${p.component} (${p.file}): ${p.issues.map((i) => i.message).join('; ')}`).join('\n')),
        }
      }),
  )

  server.registerTool(
    'trivia_add_pages',
    {
      title: 'Add pages for a resource',
      description:
        'Generate the Refine pages a contract resource is missing (list, create, edit, show), written the way the ' +
        'other pages are (columns, forms and fields from the OpenAPI contract), register them in <Refine resources> and ' +
        'add their routes, as one entry in the designer\'s undo history (undo deletes the files). Without pages: every ' +
        'kind the contract supports that the app doesn\'t have yet. trivia_get_page lists the resources and their pages.',
      inputSchema: {
        resource: z.string().min(1).describe('The contract resource, e.g. "Account" (or its Refine name, "accounts")'),
        pages: z.array(z.enum(['list', 'create', 'edit', 'show'])).min(1).optional(),
        label: z.string().min(1).describe('A few words for the undo menu, e.g. "Add account pages"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ resource, pages, label }) =>
      run(async () => {
        const entry = `${AGENT_LABEL}${label.trim()}`
        const plan = await service.refine.planPages(resource, pages)
        const result = await service.batch(plan.ops, entry, { by: 'agent' })
        const files = plan.ops.filter((o) => o['op'] === 'createFile').map((o) => o['file'] as string)
        return {
          data: { ...result, files, resources: await service.refine.resources() },
          summary: `Applied "${entry}": ${plan.label} (${files.join(', ')}).`,
        }
      }),
  )

  server.registerTool(
    'trivia_edit_columns',
    {
      title: 'Edit a list page\'s columns',
      description:
        'Add contract fields as columns of a Refine list page (each written by its type: a badge and a multi-select ' +
        'filter for enums, a numeric filter for numbers, a date range filter and a formatted cell for dates), and remove ' +
        'or reorder columns by key, as one entry in the designer\'s undo history. Changes apply in order; an index ' +
        'counts the columns after the changes before it.',
      inputSchema: {
        file: z.string().min(1).describe('The page file, from trivia_get_page'),
        component: z.string().min(1).optional().describe('The page component, when the file has several'),
        changes: z.array(columnChange).min(1),
        label: z.string().min(1).describe('A few words for the undo menu, e.g. "Show KYC status"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ file, component, changes, label }) =>
      run(async () => {
        const entry = `${AGENT_LABEL}${label.trim()}`
        const plan = await service.refine.planColumns(file, component, parseColumnChanges(changes))
        const result = await service.batch(plan.ops, entry, { by: 'agent' })
        const pages = (await service.refine.page(file)).filter((p): p is ListPage => p.kind === 'list')
        const page = (component ? pages.find((p) => p.component === component) : pages[0]) ?? null
        return {
          data: { ...result, page, selection: service.selection() },
          summary: `Applied "${entry}": ${plan.label}. Columns now: ${page?.columns.map((c) => c.key).join(', ') ?? '?'}.`,
        }
      }),
  )

  server.registerTool(
    'trivia_edit_fields',
    {
      title: 'Edit a form\'s fields',
      description:
        'Add request-body fields of the contract to a Refine form page (each as its zod rule with the contract\'s bounds, ' +
        'its default value and a control in the form\'s own style: a react-hook-form Controller around a shadcn Field, or ' +
        'shadcn\'s FormField; a Select for enums, a number input, a date input, a checkbox for booleans, a textarea for ' +
        'long text, else a text input), and remove or reorder fields by name, as one entry in the designer\'s undo ' +
        'history. Without an index, a new field goes after the field before it in the contract, inside that field\'s ' +
        'wrapper. Changes apply in order; an index counts the fields the form renders after the changes before it.',
      inputSchema: {
        file: z.string().min(1).describe('The form page file, from trivia_get_page'),
        component: z.string().min(1).optional().describe('The form component, when the file has several'),
        changes: z.array(fieldChange).min(1),
        label: z.string().min(1).describe('A few words for the undo menu, e.g. "Ask for the credit limit"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ file, component, changes, label }) =>
      run(async () => {
        const entry = `${AGENT_LABEL}${label.trim()}`
        const plan = await service.refine.planFields(file, component, parseFieldChanges(changes))
        const result = await service.batch(plan.ops, entry, { by: 'agent' })
        const forms = (await service.refine.page(file)).filter((p) => p.kind === 'form')
        const page = (component ? forms.find((p) => p.component === component) : forms[0]) ?? null
        // Data, not just text: the client shows the model structuredContent.
        return {
          data: { ...result, page, selection: service.selection(), ...(plan.warnings ? { warnings: plan.warnings } : {}) },
          summary:
            `Applied "${entry}": ${plan.label}. Fields now: ${page && page.kind === 'form' ? page.fields.map((f) => f.name).join(', ') : '?'}.` +
            (plan.warnings ? `\nCheck: ${plan.warnings.join('\n')}` : ''),
        }
      }),
  )

  server.registerTool(
    'trivia_screenshot',
    {
      title: 'See the canvas',
      description:
        'A PNG of the user\'s app as the Trivia designer\'s canvas renders it (the whole page, up to 4000 px tall), to ' +
        'check what an edit looks like. Needs the designer open in a browser; it takes a few seconds.',
      annotations: reads,
    },
    async (): Promise<CallToolResult> => {
      try {
        const shot = await service.screenshot()
        return {
          content: [
            { type: 'image', data: shot.png, mimeType: 'image/png' },
            { type: 'text', text: `The canvas, ${shot.width}×${shot.height} px.` },
          ],
        }
      } catch (error) {
        if (error instanceof ApiError) return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}` }] }
        throw error
      }
    },
  )

  server.registerTool(
    'trivia_sync_openapi',
    {
      title: 'Regenerate the API client',
      description:
        'Re-run contract-sync: regenerate the typed TanStack Query client (and zod schemas) and trivia.manifest.json ' +
        'from the OpenAPI spec, by default the one the manifest names. Refused when the generated code has uncommitted ' +
        'changes it would replace (commit first, or pass force). Not in the undo history: git is the undo.',
      inputSchema: {
        input: z.string().optional().describe('Spec path (project-relative) or URL; default: the manifest\'s source'),
        zod: z.boolean().optional().describe('Generate zod schemas (needed for forms); default: as before'),
        force: z.boolean().optional().describe('Replace uncommitted changes to the generated code'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ input, zod, force }) =>
      run(async () => {
        const result = await service.syncContract({
          ...(input !== undefined ? { input } : {}),
          ...(zod !== undefined ? { zod } : {}),
          ...(force !== undefined ? { force } : {}),
        })
        const note = result.contractChanged
          ? null
          : `The contract is the same as at the last sync: ${result.source} has not changed, so neither did the generated ` +
            'code. If the backend changed its API, that spec has not been updated yet.'
        return {
          data: { ...result, ...(note ? { note } : {}) },
          summary: `Regenerated ${result.files} files in ${result.outputDir} from ${result.source}: ${result.resources.join(', ')}.${note ? ` ${note}` : ''}`,
        }
      }, {
        conflict: 'Ask the user to commit those files first, or whether to replace their changes (force: true).',
      }),
  )

  server.registerTool(
    'trivia_undo',
    {
      title: 'Undo an edit',
      description:
        'Undo the most recent entry of the undo history the designer shares, which may be the user\'s. Pass the label you ' +
        'expect to undo (history.undoLabel from your last trivia_apply result, or from trivia_get_selection): the undo is ' +
        'refused when the next entry is another one. Agents\' entries are labelled "Agent: …"; the others are the user\'s.',
      inputSchema: { label: z.string().min(1).describe('The undoLabel to undo, e.g. "Agent: Make Save outline"') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ label }) =>
      run(async () => {
        const next = service.history().undoLabel
        if (next !== label) {
          throw new ApiError('conflict', `the next undo is ${next === null ? 'nothing' : `"${next}"`}, not "${label}"; nothing was undone`)
        }
        const result = await service.undo()
        return { data: { ...result }, summary: `Undid "${label}".` }
      }, {
        conflict:
          'Nothing was undone. If another entry is next, it may be the user\'s own edit: tell the user rather than undoing ' +
          'it. If the file was edited since, Trivia can no longer undo that entry: tell the user.',
      }),
  )
}
