import type { ComponentManifest, Diagnostic } from '@trivia/blueprint'
import { z } from 'zod'

import { ApiError } from '../engine.js'

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

export function previewPage(_request: z.infer<typeof previewInput>): PreviewResult {
  throw new ApiError('unsupported', 'Blueprint preview needs the page compiler from spec 005.')
}
