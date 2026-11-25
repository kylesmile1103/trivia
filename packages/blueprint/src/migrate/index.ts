import { BLUEPRINT_VERSION } from '../types/common.js'

export type DocKind = 'app' | 'page' | 'model'

/** Migrates a document from version N to N+1. Must not mutate its input. */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>

/** For each kind, the migration out of version N, keyed by N. */
export type MigrationTable = Record<DocKind, Readonly<Record<number, Migration>>>

/** The shipped migrations. Version 1 has none. */
export const MIGRATIONS: MigrationTable = { app: {}, page: {}, model: {} }

export type MigrateResult =
  | { ok: true; doc: unknown; from: number; migrated: boolean }
  | { ok: false; code: 'unsupported_version' | 'schema_violation'; message: string }

function isDocumentObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: object | null = Object.getPrototypeOf(value)
  // JSON can have been parsed in another realm with its own Object.prototype.
  return prototype === null || (Object.getPrototypeOf(prototype) === null && Object.hasOwn(prototype, 'isPrototypeOf'))
}

function errorMessage(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error)
  } catch {
    return 'Unknown error'
  }
}

export function migrate(
  kind: DocKind,
  doc: unknown,
  options?: { table?: MigrationTable; current?: number },
): MigrateResult {
  try {
    if (!isDocumentObject(doc)) {
      return { ok: false, code: 'schema_violation', message: 'Expected a JSON object document' }
    }
    const from = Object.hasOwn(doc, 'blueprintVersion') ? doc.blueprintVersion : undefined
    if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) {
      return { ok: false, code: 'schema_violation', message: 'blueprintVersion must be a non-negative integer' }
    }

    const current = options?.current ?? BLUEPRINT_VERSION
    if (!Number.isInteger(current) || current < 0) {
      return { ok: false, code: 'schema_violation', message: 'Current version must be a non-negative integer' }
    }
    if (from > current) {
      return {
        ok: false, code: 'unsupported_version',
        message: `${kind} document version ${from} is newer than current version ${current}`,
      }
    }
    if (from === current) return { ok: true, doc, from, migrated: false }

    const steps = (options?.table ?? MIGRATIONS)[kind]
    let migrated = structuredClone(doc)
    for (let version = from; version < current; version += 1) {
      const next = version + 1
      if (next - version !== 1) {
        return {
          ok: false, code: 'unsupported_version',
          message: `Cannot represent the next ${kind} version after ${version}`,
        }
      }
      const step = Object.hasOwn(steps, version) ? steps[version] : undefined
      if (step === undefined) {
        return {
          ok: false, code: 'unsupported_version',
          message: `Missing ${kind} migration from version ${version} to ${next}`,
        }
      }

      const result = step(migrated)
      if (!isDocumentObject(result)) {
        return {
          ok: false, code: 'schema_violation',
          message: `${kind} migration from version ${version} to ${next} must return a JSON object`,
        }
      }
      migrated = { ...result, blueprintVersion: next }
      const suffix = `.v${version}.json`
      const schema = migrated.$schema
      if (typeof schema === 'string' && schema.endsWith(suffix)) {
        migrated.$schema = `${schema.slice(0, -suffix.length)}.v${next}.json`
      }
    }
    return { ok: true, doc: migrated, from, migrated: true }
  } catch (error) {
    return { ok: false, code: 'schema_violation', message: `Could not migrate ${kind} document: ${errorMessage(error)}` }
  }
}
