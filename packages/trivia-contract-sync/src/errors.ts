// One error type for every failure this package reports. `code` is stable and machine-readable;
// `message` says what went wrong and `hint` (when present) says what to do next.

export type ContractSyncErrorCode =
  | 'input_not_found'
  | 'input_unreadable'
  | 'input_parse_failed'
  | 'input_invalid'
  | 'network_error'
  | 'http_error'
  | 'unsupported_spec'
  | 'unsupported_ref'
  | 'ref_cycle'
  | 'codegen_failed'
  | 'unsafe_output_dir'
  | 'runtime_dependency'
  | 'reconcile_failed'
  | 'classification_conflict'
  | 'environment'
  | 'usage'

export class ContractSyncError extends Error {
  readonly code: ContractSyncErrorCode
  readonly hint: string | undefined

  constructor(code: ContractSyncErrorCode, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ContractSyncError'
    this.code = code
    this.hint = options?.hint
  }
}

/** Best-effort readable message for an unknown thrown value, unwrapping hey-api's job wrappers. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    // hey-api wraps job failures: JobError { originalError: { error } } with an empty message,
    // ConfigValidationError { errors: [{ error }] }.
    const record = error as Error & {
      originalError?: { error?: unknown } | Error
      errors?: ReadonlyArray<{ error?: unknown }>
    }
    const inner =
      record.originalError instanceof Error
        ? record.originalError
        : (record.originalError as { error?: unknown } | undefined)?.error
    if (inner !== undefined && inner !== error) {
      const innerText = describeError(inner)
      return record.message ? `${record.message}: ${innerText}` : innerText
    }
    if (record.errors?.length) {
      return [record.message, ...record.errors.map((entry) => describeError(entry.error))].join('; ')
    }
    return record.message || record.name
  }
  return String(error)
}
