// What the engine API does, independent of how it is reached: the HTTP routes (./http.ts) and
// the MCP tools (../mcp) both call this. Edits run through one queue, so two edits never
// interleave their read-modify-write of a file, and land in one undo history, whoever sent
// them.

import { ApiError, type EngineBinding, type GuardedWrite, type OpsResult, unwrap } from '../engine.js'
import type { ApplyResult, Health, HistoryResult, HistoryState } from '../types.js'
import { History } from './history.js'
import { SerialQueue } from './queue.js'
import { type Selected, type SelectionState, SelectionStore, rebase } from './selection.js'

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

/** Who sent an edit: the designer (or another HTTP client), or an agent through MCP. */
export interface EditSource {
  /** An agent's edit moves the published selection along with the node it was on. */
  by?: 'designer' | 'agent'
}

export class EngineService {
  readonly #options: ServiceOptions
  readonly #history: History
  readonly #queue = new SerialQueue()
  readonly #selection = new SelectionStore()

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

  /** Every JSX tree of the project-relative `file`, with locators (docs/api.md). */
  outline(file: string): unknown[] {
    if (!file) throw new ApiError('invalid_op', 'missing file (project-relative, e.g. src/pages/Home.tsx)')
    return unwrap<unknown[]>(this.#options.engine.outline(this.#options.root, file))
  }

  history(): HistoryState {
    return this.#history.state()
  }

  selection(): SelectionState {
    return this.#selection.get()
  }

  /** The designer's selection changed (null: nothing selected). */
  select(selection: Selected | null): SelectionState {
    if (selection !== null && !isLocator(selection.locator)) {
      throw new ApiError('invalid_locator', `invalid locator \`${selection.locator}\` (expected \`<file>#<component>#<i.j.k>\`)`)
    }
    return this.#selection.set(selection, 'designer')
  }

  /** One op, one undo entry. `label` defaults to a description of the op. */
  apply(op: unknown, label?: string, source: EditSource = {}): Promise<ApplyResult> {
    if (!isObject(op)) throw new ApiError('invalid_op', 'an op must be an object ({ op: "updateProp", … }, docs/api.md)')
    return this.#queue.run(() => this.#transact([op], label ?? describe(op), source))
  }

  /** Several ops as one transaction: all files are written or none, as one undo entry. */
  batch(ops: unknown, label?: string, source: EditSource = {}): Promise<ApplyResult> {
    if (!Array.isArray(ops) || ops.length === 0 || !ops.every(isObject)) {
      throw new ApiError('invalid_op', 'ops must be a non-empty array of op objects')
    }
    return this.#queue.run(() => this.#transact(ops, label ?? `${ops.length} edits`, source))
  }

  undo(): Promise<HistoryResult> {
    return this.#queue.run(() => this.#travel('undo'))
  }

  redo(): Promise<HistoryResult> {
    return this.#queue.run(() => this.#travel('redo'))
  }

  /** Apply ops as one transaction (the engine writes all files or none) and record it. */
  #transact(ops: Json[], label: string, source: EditSource): ApplyResult {
    const { engine, root } = this.#options
    const result = unwrap<OpsResult>(engine.applyOps(root, JSON.stringify(ops)))
    if (result.changes.length > 0) this.#history.record({ label, changes: result.changes })
    if (source.by === 'agent' && result.changed) this.#follow(ops, result.locator)
    return { file: result.file, changed: result.changed, locator: result.locator, history: this.#history.state() }
  }

  /**
   * Move the published selection with an agent's edit: to where its node now is, checked by
   * tag name, or to nothing when that can't be known (the node was removed, the tag there is
   * another one, several ops ran). Never to whatever slid into its old position.
   */
  #follow(ops: Json[], resultLocator: string | null): void {
    const current = this.#selection.get().selection
    if (current === null) return
    const [only] = ops
    let next = ops.length === 1 && only ? rebase(current.locator, only, resultLocator) : current.locator
    if (next !== null) {
      try {
        const details = unwrap<{ name: string }>(this.#options.engine.inspect(this.#options.root, next))
        if (details.name !== current.name) next = null
      } catch {
        next = null
      }
    }
    this.#selection.set(next === null ? null : { locator: next, name: current.name }, 'agent')
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

function isLocator(value: string): boolean {
  return /^.+#[^#]+#(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(value)
}

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
