// BlueprintOps (LLD-01 section 4, FR-BP-07): the only way a blueprint changes. Every op names
// its document and the rev its author read (`null`: the document must not exist yet). Node ops
// also name the type they expect the node they address to have: for `addNode` that node is the
// parent. Model ops are spec 008.
import { z } from 'zod'

import { API_TARGETS, AUTH_MODES, WEB_TARGETS, navEntrySchema } from './app.js'
import { EVENT, NODE_TYPE, PAGE_NAME, PROP, ROUTE, SLOT, TOKEN, contractName, expression, json, name, nodeId, pageName } from './common.js'
import { CONTRACT_KINDS, PAGE_KINDS, actionStepSchema, contractOptionsSchema, controlSchema, querySchema, stateSchema } from './page.js'

export const APP_DOC = 'app.blueprint.json'
export const MODEL_DOC = 'model.blueprint.json'
export const PAGE_DOC = new RegExp(`^pages/${PAGE_NAME.source.slice(1, -1)}\\.page\\.json$`)
export const pageDocPath = (page: string): string => `pages/${page}.page.json`

const rev = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const appOp = { doc: z.literal(APP_DOC), baseRev: rev.nullable() }
const pageOp = { doc: z.string().regex(PAGE_DOC), baseRev: rev.nullable() }
const nodeOp = { ...pageOp, node: nodeId, expectedType: z.string().regex(NODE_TYPE) }

/** Where a node goes among its new siblings: before or after one, at an index, or (none) last. */
const position = {
  before: nodeId.optional(),
  after: nodeId.optional(),
  index: z.number().int().min(0).optional(),
}
const onePosition = (op: { before?: string | undefined; after?: string | undefined; index?: number | undefined }) =>
  [op.before, op.after, op.index].filter((p) => p !== undefined).length <= 1
const onePositionMessage = { message: 'Give at most one of before, after and index' }

export const blueprintOpSchema = z.discriminatedUnion('op', [
  // App
  z.strictObject({
    op: z.literal('setApp'),
    ...appOp,
    name: pageName.optional(),
    targets: z.strictObject({ web: z.enum(WEB_TARGETS).optional(), api: z.enum(API_TARGETS).nullable().optional() }).optional(),
    auth: z.strictObject({ mode: z.enum(AUTH_MODES) }).optional(),
    /** Per token: a value sets it, null removes it. */
    theme: z.strictObject({ tokens: z.record(z.string().regex(TOKEN), z.string().min(1).nullable()) }).optional(),
  }),
  z.strictObject({ op: z.literal('setNav'), ...appOp, nav: z.array(navEntrySchema) }),
  // Page
  z.strictObject({
    op: z.literal('createPage'),
    ...pageOp,
    name: pageName,
    route: z.string().regex(ROUTE),
    kind: z.enum(PAGE_KINDS),
    resource: contractName.optional(),
    public: z.boolean().optional(),
    options: contractOptionsSchema.optional(),
    /** A custom page starts with one root node, a `div` named `page` unless given. */
    rootType: z.string().regex(NODE_TYPE).optional(),
  }),
  z.strictObject({ op: z.literal('deletePage'), ...pageOp }),
  z.strictObject({
    op: z.literal('setPageMeta'),
    ...pageOp,
    /** A new name moves the document to `pages/<name>.page.json`. */
    name: pageName.optional(),
    route: z.string().regex(ROUTE).optional(),
    kind: z.enum(CONTRACT_KINDS).optional(),
    resource: contractName.nullable().optional(),
    public: z.boolean().optional(),
    options: contractOptionsSchema.optional(),
  }),
  // Nodes
  z.strictObject({
    op: z.literal('addNode'),
    ...pageOp,
    parent: nodeId,
    expectedType: z.string().regex(NODE_TYPE),
    type: z.string().regex(NODE_TYPE),
    name,
    slot: z.string().regex(SLOT),
    ...position,
  }).refine(onePosition, onePositionMessage),
  z.strictObject({ op: z.literal('removeNode'), ...nodeOp }),
  z.strictObject({
    op: z.literal('moveNode'),
    ...nodeOp,
    parent: nodeId,
    slot: z.string().regex(SLOT),
    ...position,
  }).refine(onePosition, onePositionMessage),
  z.strictObject({ op: z.literal('renameNode'), ...nodeOp, name }),
  // Values: null removes.
  z.strictObject({ op: z.literal('setProp'), ...nodeOp, prop: z.string().regex(PROP), value: json }),
  z.strictObject({ op: z.literal('setBinding'), ...nodeOp, prop: z.string().regex(PROP), expr: expression.nullable() }),
  z.strictObject({ op: z.literal('setStyle'), ...nodeOp, className: z.string().nullable() }),
  z.strictObject({ op: z.literal('setControl'), ...nodeOp, control: controlSchema.nullable() }),
  // Logic
  z.strictObject({ op: z.literal('setState'), ...pageOp, name, type: stateSchema.shape.type, initial: json }),
  z.strictObject({ op: z.literal('removeState'), ...pageOp, name }),
  z.strictObject({ op: z.literal('setQuery'), ...pageOp, name, query: querySchema }),
  z.strictObject({ op: z.literal('removeQuery'), ...pageOp, name }),
  /** The steps of one event; an empty list removes the entry. */
  z.strictObject({ op: z.literal('setActions'), ...nodeOp, event: z.string().regex(EVENT), steps: z.array(actionStepSchema) }),
])

export type BlueprintOp = z.output<typeof blueprintOpSchema>
export type BlueprintOpInput = z.input<typeof blueprintOpSchema>
export type OpName = BlueprintOp['op']
export type OpOf<N extends OpName> = Extract<BlueprintOp, { op: N }>

export const OP_NAMES: readonly OpName[] = [
  'setApp', 'setNav', 'createPage', 'deletePage', 'setPageMeta', 'addNode', 'removeNode', 'moveNode', 'renameNode',
  'setProp', 'setBinding', 'setStyle', 'setControl', 'setState', 'removeState', 'setQuery', 'removeQuery', 'setActions',
]
