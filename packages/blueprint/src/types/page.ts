// A page document, `pages/<Name>.page.json` (LLD-01 section 2). Contract pages (`list`,
// `create`, `edit`, `show`) carry a resource and options; `custom` pages carry the flat maps
// (FR-BP-02, FR-BP-09). Property order here is the order the canonical serializer writes.
import { z } from 'zod'

import {
  ACTION_KEY, HANDLER, NODE_TYPE, ORDER_KEY, PAGE_ID, PROP, ROUTE, SCHEMA_URL, SLOT,
  contractName, expression, json, name, nodeId, pageName,
} from './common.js'

export const CONTRACT_KINDS = ['list', 'create', 'edit', 'show'] as const
export const PAGE_KINDS = [...CONTRACT_KINDS, 'custom'] as const
export const TOAST_VARIANTS = ['default', 'success', 'info', 'warning', 'error'] as const

export const nodeSchema = z.strictObject({
  type: z.string().regex(NODE_TYPE),
  name,
  parent: nodeId.nullable(),
  slot: z.string().regex(SLOT).nullable(),
  order: z.string().regex(ORDER_KEY),
})

/** `when` renders conditionally; `each` + `as` + `key` repeats, optionally filtered by `when`. */
export const controlSchema = z.union([
  z.strictObject({ when: expression }),
  z.strictObject({ when: expression.optional(), each: expression, as: name, key: expression }),
])

export const stateSchema = z.strictObject({
  /** A TypeScript type, checked by `tsc` after emission (LLD-01 section 10). */
  type: z.string().min(1),
  initial: json,
})

const params = z.record(contractName, expression).default(() => ({}))
export const querySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('list'), resource: contractName, params, enabled: expression.optional() }),
  z.strictObject({ kind: z.literal('one'), resource: contractName, params, enabled: expression.optional() }),
  z.strictObject({
    kind: z.literal('custom'), resource: contractName, operation: contractName, params, enabled: expression.optional(),
  }),
])

export const actionStepSchema = z.discriminatedUnion('do', [
  z.strictObject({ do: z.literal('setState'), name, value: expression }),
  z.strictObject({ do: z.literal('navigate'), to: expression }),
  z.strictObject({
    do: z.literal('mutate'), resource: contractName, operation: contractName,
    input: expression.optional(), id: expression.optional(),
  }),
  z.strictObject({ do: z.literal('refetch'), query: name }),
  z.strictObject({ do: z.literal('toast'), message: expression, variant: z.enum(TOAST_VARIANTS).optional() }),
  /** The escape hatch: an exported function of `src/handlers/<page>.ts`. */
  z.strictObject({ do: z.literal('call'), handler: z.string().regex(HANDLER) }),
])

/** A button of a contract page; row actions get `row` in scope (LLD-05 section 2). */
export const pageActionSchema = z.strictObject({
  name,
  label: z.string().min(1),
  /** ⚑ The confirmation text; absent means no confirmation. */
  confirm: z.string().min(1).optional(),
  steps: z.array(actionStepSchema).min(1),
})

export const contractOptionsSchema = z.strictObject({
  fields: z.array(contractName).optional(),
  hideFields: z.array(contractName).optional(),
  title: z.string().min(1).optional(),
  filters: z.array(contractName).optional(),
  rowActions: z.array(pageActionSchema).optional(),
  headerActions: z.array(pageActionSchema).optional(),
})

const envelope = {
  $schema: z.literal(SCHEMA_URL.page),
  blueprintVersion: z.literal(1),
  id: z.string().regex(PAGE_ID),
  name: pageName,
  route: z.string().regex(ROUTE),
}

export const contractPageSchema = z.strictObject({
  ...envelope,
  kind: z.enum(CONTRACT_KINDS),
  resource: contractName,
  /** May the Next.js target cache its static tier (LLD-12). */
  public: z.boolean().default(false),
  options: contractOptionsSchema.default(() => ({})),
})

const perNode = <T extends z.ZodType>(value: T) => z.record(nodeId, value).default(() => ({}))

export const customPageSchema = z.strictObject({
  ...envelope,
  kind: z.literal('custom'),
  resource: contractName.optional(),
  public: z.boolean().default(false),
  root: nodeId,
  nodes: perNode(nodeSchema),
  props: perNode(z.record(z.string().regex(PROP), json)),
  bindings: perNode(z.record(z.string().regex(PROP), expression)),
  styles: perNode(z.strictObject({ className: z.string() })),
  control: perNode(controlSchema),
  state: z.record(name, stateSchema).default(() => ({})),
  queries: z.record(name, querySchema).default(() => ({})),
  actions: z.record(z.string().regex(ACTION_KEY), z.array(actionStepSchema).min(1)).default(() => ({})),
})

export const pageSchema = z.discriminatedUnion('kind', [contractPageSchema, customPageSchema])

export type PageDoc = z.output<typeof pageSchema>
export type ContractPage = z.output<typeof contractPageSchema>
export type CustomPage = z.output<typeof customPageSchema>
export type PageKind = PageDoc['kind']
export type BlueprintNode = z.output<typeof nodeSchema>
export type Control = z.output<typeof controlSchema>
export type StateEntry = z.output<typeof stateSchema>
export type Query = z.output<typeof querySchema>
export type ActionStep = z.output<typeof actionStepSchema>
export type ContractOptions = z.output<typeof contractOptionsSchema>

/** The per-node maps of a custom page, which `removeNode` clears for a whole subtree. */
export const NODE_MAPS = ['props', 'bindings', 'styles', 'control'] as const
