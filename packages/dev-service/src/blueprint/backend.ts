import type { Diagnostic } from '@trivia/blueprint'
import { z } from 'zod'

import { ApiError } from '../engine.js'
import type { BlueprintWorkspace } from './store.js'

export interface BackendResult {
  files: Array<{ path: string; kind: 'generated' | 'scaffold'; action: 'create' | 'update' | 'unchanged' | 'refused' }>
  written: boolean
  diagnostics: Diagnostic[]
  log: string
}

export const backendInput = z.strictObject({
  mode: z.enum(['plan', 'write']),
  migration: z.string().min(1).optional(),
  force: z.boolean().optional(),
})

export async function runBackend(_workspace: BlueprintWorkspace, _request: z.infer<typeof backendInput>): Promise<BackendResult> {
  throw new ApiError('unsupported', 'Regenerating the blueprint backend needs the trivia-dotnet integration from spec 009.')
}
