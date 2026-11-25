// Wire shapes of the engine HTTP API (docs/api.md) that this plugin produces. The designer's
// mirror is packages/designer/src/shared/engine/types.ts; keep the two in sync.

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

/** One file's net change; history entries are lists of these. `null`: the file didn't (or no longer does) exist. */
export interface FileChange {
  file: string
  before: string | null
  after: string | null
}

/** Whether the spec still hashes to what the generated code was made from (GET /manifest). */
export interface Drift {
  /** current: same spec; changed: re-run contract-sync; unknown: a URL source, or the spec is gone. */
  status: 'current' | 'changed' | 'unknown'
  /** The manifest's `source.location`. */
  source: string | null
  manifestHash: string | null
  specHash: string | null
}

export interface ManifestState {
  /** trivia.manifest.json (contract-sync's TriviaManifest), or null when the project has none. */
  manifest: unknown
  drift: Drift | null
}
