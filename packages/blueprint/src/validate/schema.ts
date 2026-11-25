// Layer 1: the schema (LLD-01 section 5). Each zod issue becomes a `schema_violation` that
// points at the offending value. Never throws.
import type { z } from 'zod'

import { appSchema } from '../types/app.js'
import { toPointer, type Diagnostic } from '../types/diagnostics.js'
import { modelSchema } from '../types/model.js'
import { pageSchema } from '../types/page.js'
import type { BlueprintDoc } from '../serialize.js'

export type SchemaKind = 'app' | 'page' | 'model'
const SCHEMAS: Record<SchemaKind, z.ZodType> = { app: appSchema, page: pageSchema, model: modelSchema }

export interface SchemaResult {
  doc: BlueprintDoc | null
  diagnostics: Diagnostic[]
}

export function checkSchema(kind: SchemaKind, value: unknown, doc: string): SchemaResult {
  const parsed = SCHEMAS[kind].safeParse(value)
  if (parsed.success) return { doc: parsed.data as BlueprintDoc, diagnostics: [] }
  return {
    doc: null,
    diagnostics: parsed.error.issues.map((issue) => ({
      code: 'schema_violation',
      severity: 'error' as const,
      doc,
      pointer: toPointer(issue.path),
      message: issue.message,
    })),
  }
}
