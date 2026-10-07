// Wire shapes of the engine HTTP API (docs/api.md) that this plugin produces. The designer's
// mirror is packages/trivia-designer/src/bridge/types.ts; keep the two in sync.

export type ErrorCode =
  | 'invalid_locator'
  | 'node_not_found'
  | 'stale_locator'
  | 'parse_error'
  | 'unsupported'
  | 'invalid_snippet'
  | 'unresolved_component'
  | 'invalid_result'
  | 'invalid_op'
  | 'path_outside_root'
  | 'io_error'
  | 'internal'
  | 'conflict'
  | 'forbidden'

export interface ApiErrorPayload {
  code: ErrorCode
  message: string
}

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: ApiErrorPayload }

export interface Health {
  root: string
  uiDir: string
  importBase: string
  version: string
}

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

export interface ApplyResult {
  file: string
  changed: boolean
  locator: string | null
  history: HistoryState
}

export interface HistoryResult {
  files: string[]
  history: HistoryState
}

/** One file's net change; history entries are lists of these. */
export interface FileChange {
  file: string
  before: string
  after: string
}
