// Diagnostics and refusals (LLD-01 sections 4 and 5). Validation never throws: everything it
// finds is a Diagnostic. A refused batch is an ApplyError with the envelope codes of docs/api.md.
import type { BlueprintOp } from './ops.js'

export type Severity = 'error' | 'warning'

export interface Diagnostic {
  /** Stable, snake_case. */
  code: string
  severity: Severity
  /** The document's path under the blueprint directory: "pages/CustomerOverview.page.json". */
  doc: string
  /** RFC 6901, inside that document: "/bindings/n_01J…/title". */
  pointer: string
  message: string
  /** A fix, as ops to send (they carry the document's current rev) or as advice. */
  hint?: { ops?: BlueprintOp[]; text?: string }
  /** Inside an expression, for the expression layer (LLD-03). */
  span?: { start: number; end: number; unit: 'utf16' }
}

/** The codes this package emits. Layers 3 to 5 add their own through the context (LLD-02, 03). */
export const DIAGNOSTIC_CODES = [
  // Reading a document.
  'invalid_json',
  'unsupported_version',
  'unknown_document',
  'missing_document',
  // Layer 1, the schema.
  'schema_violation',
  // Layer 2, references.
  'dangling_reference',
  'duplicate_name',
  'duplicate_route',
  'duplicate_order',
  'duplicate_prop',
  'parent_cycle',
  'invalid_root',
  'missing_slot',
  'file_name_mismatch',
] as const
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number]

/** Refusal codes and their HTTP statuses (docs/api.md's envelope). */
export const ERROR_STATUS = { conflict: 409, node_not_found: 404, invalid_op: 400, invalid_result: 422 } as const
export type ErrorCode = keyof typeof ERROR_STATUS

export interface ApplyError {
  code: ErrorCode
  status: (typeof ERROR_STATUS)[ErrorCode]
  message: string
  /** The index of the op in the batch that was refused, when one was. */
  op?: number
  /** `conflict`: the current revs; `invalid_result`: the blocking diagnostics. */
  details?: Record<string, unknown>
}

export function applyError(code: ErrorCode, message: string, extra: Omit<ApplyError, 'code' | 'status' | 'message'> = {}): ApplyError {
  return { code, status: ERROR_STATUS[code], message, ...extra }
}

/** RFC 6901: `~` is `~0`, `/` is `~1`. */
export function toPointer(path: ReadonlyArray<PropertyKey>): string {
  return path.map((part) => '/' + String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('')
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error')
}
