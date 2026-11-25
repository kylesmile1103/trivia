import { ApiError, engine } from '@/shared/engine/client'
import type { BlueprintDiagnostic, RegistryItem } from '@/shared/engine/types'

export const blueprintApi = engine.blueprint
export type BlueprintClient = Pick<typeof blueprintApi, 'summary' | 'doc' | 'patch'>

export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'conflict'
}

export function problemOf(error: unknown): { message: string; diagnostics: BlueprintDiagnostic[] } {
  const diagnostics = error instanceof ApiError ? error.details?.diagnostics : undefined
  return {
    message: error instanceof Error ? error.message : String(error),
    diagnostics: Array.isArray(diagnostics) ? diagnostics as BlueprintDiagnostic[] : [],
  }
}

export function requirementsOf(error: unknown): RegistryItem[] {
  if (!(error instanceof ApiError) || error.status !== 422 || error.code !== 'unresolved_component') return []
  const requires = error.details?.requires
  return Array.isArray(requires) ? requires as RegistryItem[] : []
}
