import type { ComponentManifest, Diagnostic } from '@trivia/blueprint'
import { CompileError, compilePage, pageDiagnostics, targetFor } from '@trivia/blueprint-compiler'
import { z } from 'zod'

import type { EngineService } from '../api/service.js'
import { ApiError } from '../engine.js'
import { PREVIEW_PREFIX } from '../refine/index.js'

export type RegistryItem = Pick<ComponentManifest['source'], 'registry' | 'item'>

export interface PreviewResult {
  page: string
  route: string
  module: string
  code: string
  requires: RegistryItem[]
  diagnostics: Diagnostic[]
}

export const previewInput = z.strictObject({ page: z.string().min(1) })

export function compilerError(error: unknown): never {
  if (error instanceof CompileError) throw new ApiError(error.code, error.message, error.details)
  throw error
}

export async function previewPage({ page }: z.infer<typeof previewInput>, service: EngineService): Promise<PreviewResult> {
  if (!service.blueprint.canPreview) throw new ApiError('unsupported', 'Blueprint preview requires a running Vite app host.')
  if (!(await service.refine.blueprintRouteAnchor())) {
    throw new ApiError('unsupported', 'The Refine app has no React Router route where a blueprint preview can be mounted.')
  }
  const { blueprint, context } = await service.blueprintInputs()
  try {
    const out = compilePage(blueprint, page, context)
    const { id, route } = targetFor(context.facts.target).preview(page)
    service.refine.blueprintPreview(id, async () => {
      const next = await service.blueprintInputs()
      // Keep code returned to callers canonical for eject. Only the virtual module gets
      // the data attributes the canvas uses to select blueprint nodes.
      return compilePage(next.blueprint, page, { ...next.context, previewNodeIds: true })
    })
    return {
      page, route, module: PREVIEW_PREFIX + id + '.tsx', code: out.code, requires: out.requires,
      diagnostics: pageDiagnostics(blueprint, page, context),
    }
  } catch (error) {
    return compilerError(error)
  }
}
