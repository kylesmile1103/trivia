// Undo/redo as byte-exact file snapshots (docs/api.md). History lives in the dev-server
// process: it is lost on restart, and it never inverts ops — undo writes `before` back,
// guarded by the engine so an edit made outside the designer is never overwritten.

import type { FileChange, HistoryState } from '../types.js'

export interface HistoryEntry {
  label: string
  changes: FileChange[]
}

export class History {
  readonly limit: number
  #undo: HistoryEntry[] = []
  #redo: HistoryEntry[] = []

  constructor(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`history limit must be a positive integer, got ${limit}`)
    this.limit = limit
  }

  /** A new edit: clears the redo stack and drops the oldest entry past the cap. */
  record(entry: HistoryEntry): void {
    this.#undo.push(entry)
    if (this.#undo.length > this.limit) this.#undo.shift()
    this.#redo = []
  }

  get nextUndo(): HistoryEntry | undefined {
    return this.#undo.at(-1)
  }

  get nextRedo(): HistoryEntry | undefined {
    return this.#redo.at(-1)
  }

  /** `nextUndo` was written back to disk. */
  undone(): void {
    const entry = this.#undo.pop()
    if (entry) this.#redo.push(entry)
  }

  /** `nextRedo` was written again. */
  redone(): void {
    const entry = this.#redo.pop()
    if (entry) this.#undo.push(entry)
  }

  state(): HistoryState {
    return {
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      undoLabel: this.nextUndo?.label ?? null,
      redoLabel: this.nextRedo?.label ?? null,
    }
  }
}
