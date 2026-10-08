// The MCP tools (docs/mcp.md): point-and-ask. The user selects an element in the designer and
// tells an agent what to change; the agent reads the selection and applies guarded ops. Every
// tool calls EngineService, so agent edits share the designer's queue and undo history.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { EngineService } from '../api/service.js'
import { ApiError } from '../engine.js'
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

const op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('updateProp'), target: locator, expectedName: guard('target'), prop: z.string().min(1), value: json.describe('The new value; null removes the prop') }).strict(),
  z.object({ op: z.literal('setText'), target: locator, expectedName: guard('target'), text: z.string().describe('The text it renders; plain text only') }).strict(),
  z.object({ op: z.literal('insert'), target: locator, expectedName: guard('target'), placement, snippet, imports }).strict(),
  z.object({ op: z.literal('insertChild'), parent: locator, expectedName: guard('parent'), index: z.number().int().min(0), snippet, imports }).strict(),
  z.object({ op: z.literal('remove'), target: locator, expectedName: guard('target') }).strict(),
  z.object({ op: z.literal('move'), source: locator, expectedName: guard('source'), target: locator, expectedTargetName: guard('target'), placement }).strict(),
  z.object({ op: z.literal('moveNode'), source: locator, expectedName: guard('source'), parent: locator, expectedParentName: guard('parent'), index: z.number().int().min(0) }).strict(),
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
])

// ---------------------------------------------------------------------------------------------

/** What to do next after each kind of refusal, for the agent. */
const NEXT: Partial<Record<ErrorCode, string>> = {
  stale_locator: 'The file changed since you read it: call trivia_get_selection (or trivia_inspect) again and retry with what it returns.',
  node_not_found: 'The file changed since you read it: call trivia_get_selection (or trivia_inspect) again and retry with what it returns.',
  conflict: 'The file changed on disk meanwhile: read it again before retrying.',
  unsupported: 'The engine cannot make this edit; tell the user, or edit the file directly (that edit will not be in Trivia\'s undo history).',
  invalid_snippet: 'Send exactly one JSX element, without surrounding parentheses or comments.',
  unresolved_component: 'Pass an import for the component (trivia_list_components gives its importSource).',
}

export function registerTools(server: McpServer, service: EngineService, log: (message: string) => void): void {
  /** Run a tool body; engine refusals become tool errors the agent can act on. */
  const run = async (body: () => Promise<{ data: Record<string, unknown>; summary: string }>): Promise<CallToolResult> => {
    try {
      const { data, summary } = await body()
      return { content: [{ type: 'text', text: `${summary}\n${JSON.stringify(data, null, 2)}` }], structuredContent: data }
    } catch (error) {
      if (error instanceof ApiError) {
        const next = NEXT[error.code]
        return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}${next ? `\n${next}` : ''}` }] }
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
        'Call this first when the user says "this", "the selected …" or "here". Pass its locator and name to trivia_apply.',
      annotations: reads,
    },
    () =>
      run(async () => {
        const { selection } = service.selection()
        if (selection === null) {
          return {
            data: { selection: null },
            summary: 'Nothing is selected in the Trivia designer. Ask the user to select an element on the canvas.',
          }
        }
        const node = describeNode(selection.locator)
        if (node.name !== selection.name) {
          throw new ApiError(
            'stale_locator',
            `the selection was <${selection.name}> but ${selection.locator} now holds <${node.name}>; ask the user to select it again`,
          )
        }
        return { data: { selection: node }, summary: `Selected: <${node.name}> at ${node.locator}` }
      }),
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
        'insertChild, remove, move, moveNode, and bindQuery (a TanStack Query hook feeding the element, docs/data-provider.md). ' +
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
    'trivia_undo',
    {
      title: 'Undo an edit',
      description:
        'Undo the most recent entry of the undo history the designer shares, which may be the user\'s. Pass the label you ' +
        'expect to undo (history.undoLabel from your last trivia_apply result): the undo is refused when the next entry is ' +
        'another one.',
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
      }),
  )
}
