import { z } from 'zod'

import type { Json } from '../api/service.js'
import { ApiError } from '../engine.js'
import type { ApplyResult } from '../types.js'
import type { RegistryItem } from './preview.js'
import type { BlueprintSummary } from './summary.js'

export interface EjectPlan {
  ops: Array<Json & { op: string }>
  files: string[]
  requires: RegistryItem[]
  warnings: string[]
  lock: object
  label: string
}

type EjectResult = ApplyResult & { files: string[]; requires: RegistryItem[]; summary: BlueprintSummary }

const pages = z.array(z.string().min(1))
export const planInput = z.strictObject({ pages: pages.optional() })
export const ejectedInput = z.strictObject({ pages, entry: z.string().min(1) })
export const ejectInput = planInput.extend({ label: z.string().trim().min(1) })

function needsCompiler(): never {
  throw new ApiError('unsupported', 'Ejecting blueprint pages needs the page compiler from spec 005.')
}

export function planEject(_request: z.infer<typeof planInput>): EjectPlan {
  return needsCompiler()
}

export function recordEjected(_request: z.infer<typeof ejectedInput>): { lockRev: string } {
  return needsCompiler()
}

export function ejectBlueprint(_request: z.infer<typeof ejectInput>): EjectResult {
  return needsCompiler()
}
