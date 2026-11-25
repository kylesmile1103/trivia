// The model document, `model.blueprint.json`. Its content is spec 008 (LLD-08). Until then
// this package checks only the envelope every document carries (FR-BP-01) and keeps the rest
// as written. ⚑ Its other properties keep their order on save until spec 008 gives them one.
import { z } from 'zod'

import { SCHEMA_URL } from './common.js'

export const modelSchema = z.looseObject({
  $schema: z.literal(SCHEMA_URL.model),
  blueprintVersion: z.literal(1),
})

export type ModelDoc = z.output<typeof modelSchema>
