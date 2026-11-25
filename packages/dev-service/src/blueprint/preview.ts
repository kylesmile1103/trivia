import type { ComponentManifest, Diagnostic } from '@trivia/blueprint'
import { CompileError, compilePage, nextPreviewFiles, pageDiagnostics, targetFor } from '@trivia/blueprint-compiler'
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
  const { blueprint: workspace } = service
  if (!workspace.canPreview) throw new ApiError('unsupported', workspace.hostKind === 'vite'
    ? 'Blueprint preview requires a running Vite app host.' : 'Blueprint preview requires a running App Router host.')
  if (workspace.hostKind === 'vite' && !(await service.refine.blueprintRouteAnchor())) {
    throw new ApiError('unsupported', 'The Refine app has no React Router route where a blueprint preview can be mounted.')
  }
  const { blueprint, context } = await service.blueprintInputs()
  try {
    const out = compilePage(blueprint, page, context)
    const { id, route, directory } = targetFor(context.facts.target).preview(page, context.facts)
    let module: string
    if (directory) {
      const { publishBlueprint } = workspace.previewHost
      if (!publishBlueprint) throw new ApiError('unsupported', 'A running App Router host is required for Next previews.')
      const facts = { ...context.facts, previewDirectory: directory }
      const draft = compilePage(blueprint, page, { ...context, facts, previewNodeIds: true })
      publishBlueprint(page, nextPreviewFiles(draft, facts))
      module = draft.file
    } else {
      service.refine.blueprintPreview(id, async () => {
        const next = await service.blueprintInputs()
        // Keep the source returned to callers canonical. The canvas uses node ids.
        return compilePage(next.blueprint, page, { ...next.context, previewNodeIds: true })
      })
      module = PREVIEW_PREFIX + id + '.tsx'
    }
    return {
      page, route, module, code: out.code, requires: out.requires,
      diagnostics: pageDiagnostics(blueprint, page, context),
    }
  } catch (error) {
    return compilerError(error)
  }
}
