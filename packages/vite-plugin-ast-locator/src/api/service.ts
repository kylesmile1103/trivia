// What the engine API does, independent of how it is reached: the HTTP routes (./http.ts) and
// the MCP tools (../mcp) both call this. Edits run through one queue, so two edits never
// interleave their read-modify-write of a file, and land in one undo history, whoever sent
// them.

import { ApiError, type EngineBinding, type GuardedWrite, type OpsResult, unwrap } from '../engine.js'
import type { ApplyResult, Health, HistoryResult, HistoryState } from '../types.js'
import { History } from './history.js'
import { SerialQueue } from './queue.js'

export type Json = Record<string, unknown>

export interface ServiceOptions {
  /** Absolute project root; every file in the API is relative to it. */
  root: string
  uiDir: string
  importBase: string
  version: string
  engine: EngineBinding
  /** Undo entries kept (docs/api.md: 100). */
  historyLimit?: number
}

export class EngineService {
  readonly #options: ServiceOptions
  readonly #history: History
  readonly #queue = new SerialQueue()

  constructor(options: ServiceOptions) {
    this.#options = options
    this.#history = new History(options.historyLimit ?? 100)
  }

  health(): Health {
    const { root, uiDir, importBase, version } = this.#options
    return { root, uiDir, importBase, version }
  }

  components(): unknown[] {
    const { engine, root, uiDir, importBase } = this.#options
    return unwrap<unknown[]>(engine.components(root, uiDir, importBase))
  }

  inspect(locator: string): unknown {
    if (!locator) throw new ApiError('invalid_locator', 'missing locator (<file>#<component>#<i.j.k>)')
    return unwrap<unknown>(this.#options.engine.inspect(this.#options.root, locator))
  }

  history(): HistoryState {
    return this.#history.state()
  }

  /** One op, one undo entry. `label` defaults to a description of the op. */
  apply(op: unknown, label?: string): Promise<ApplyResult> {
    if (!isObject(op)) throw new ApiError('invalid_op', 'an op must be an object ({ op: "updateProp", … }, docs/api.md)')
    return this.#queue.run(() => this.#transact([op], label ?? describe(op)))
  }

  /** Several ops as one transaction: all files are written or none, as one undo entry. */
  batch(ops: unknown, label?: string): Promise<ApplyResult> {
    if (!Array.isArray(ops) || ops.length === 0 || !ops.every(isObject)) {
      throw new ApiError('invalid_op', 'ops must be a non-empty array of op objects')
    }
    return this.#queue.run(() => this.#transact(ops, label ?? `${ops.length} edits`))
  }

  undo(): Promise<HistoryResult> {
    return this.#queue.run(() => this.#travel('undo'))
  }

  redo(): Promise<HistoryResult> {
    return this.#queue.run(() => this.#travel('redo'))
  }

  /** Apply ops as one transaction (the engine writes all files or none) and record it. */
  #transact(ops: Json[], label: string): ApplyResult {
    const { engine, root } = this.#options
    const result = unwrap<OpsResult>(engine.applyOps(root, JSON.stringify(ops)))
    if (result.changes.length > 0) this.#history.record({ label, changes: result.changes })
    return { file: result.file, changed: result.changed, locator: result.locator, history: this.#history.state() }
  }

  /** Undo writes each `before` back where the file still holds `after`; redo mirrors it. */
  #travel(direction: 'undo' | 'redo'): HistoryResult {
    const history = this.#history
    const entry = direction === 'undo' ? history.nextUndo : history.nextRedo
    if (!entry) return { files: [], history: history.state() }
    const writes: GuardedWrite[] =
      direction === 'undo'
        ? entry.changes.toReversed().map((c) => ({ file: c.file, expected: c.after, content: c.before }))
        : entry.changes.map((c) => ({ file: c.file, expected: c.before, content: c.after }))
    try {
      unwrap<null>(this.#options.engine.restoreFiles(this.#options.root, JSON.stringify(writes)))
    } catch (error) {
      if (error instanceof ApiError) throw new ApiError(error.code, `${direction} "${entry.label}" failed: ${error.message}`)
      throw error
    }
    if (direction === 'undo') history.undone()
    else history.redone()
    return { files: entry.changes.map((c) => c.file), history: history.state() }
  }
}

/** A default history label when the caller sends none. */
function describe(op: Json): string {
  const name = typeof op['expectedName'] === 'string' ? `<${op['expectedName']}>` : 'element'
  const prop = typeof op['prop'] === 'string' ? op['prop'] : 'prop'
  switch (op['op']) {
    case 'updateProp':
      return op['value'] === null ? `Remove ${prop}` : `Set ${prop}`
    case 'setText':
      return `Set text of ${name}`
    case 'insert':
    case 'insertChild':
      return 'Insert element'
    case 'remove':
      return `Remove ${name}`
    case 'move':
    case 'moveNode':
      return `Move ${name}`
    case 'bindQuery':
      return `Bind ${name} to ${typeof op['optionsFn'] === 'string' ? op['optionsFn'] : 'a query'}`
    default:
      return 'Edit'
  }
}

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
