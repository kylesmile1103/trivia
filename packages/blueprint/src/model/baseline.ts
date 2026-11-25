import { z } from 'zod'

import { MODEL_MAPPING } from './mapping.js'
import { modelMemberName, modelTypeName, type ModelDoc, type ModelFieldType } from './types.js'
import { modelFieldTypes } from './validate.js'

const modelFieldSummary = z.strictObject({
  type: z.enum(Object.keys(MODEL_MAPPING) as ModelFieldType[]),
  required: z.boolean(),
  hasDefault: z.boolean(),
  enumValues: z.array(z.string()).optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  precision: z.number().optional(),
  scale: z.number().optional(),
})

export const modelBaselineSchema = z.strictObject({
  rev: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  entities: z.record(modelTypeName, z.record(modelMemberName, modelFieldSummary)),
})

export type ModelBaseline = z.infer<typeof modelBaselineSchema>

export function summarizeModel(model: ModelDoc, rev: string): ModelBaseline {
  const entities = new Map(model.entities.map((entity) => [entity.name, entity]))
  const enums = new Map(model.enums.map(({ name, values }) => [name, values]))
  return {
    rev,
    entities: Object.fromEntries([...entities.keys()].sort().map((name) => {
      const entity = entities.get(name)!
      const declared = new Map(entity.fields.map((field) => [field.name, field]))
      const foreign = new Map(entity.relations.flatMap((relation) =>
        relation.kind === 'belongsTo' ? [[relation.foreignKey, relation.required === true] as const] : []))
      const fields = modelFieldTypes(entity, entities)
      return [name, Object.fromEntries([...fields.keys()].sort().flatMap((name) => {
        const type = fields.get(name)
        if (type === undefined) return []
        const field = declared.get(name)
        const key = name === entity.key.name
        return [[name, {
          type,
          required: key || (field ? field.required === true : foreign.get(name) === true),
          hasDefault: key || field?.default !== undefined || (!!field && 'generated' in field && field.generated !== undefined),
          ...(field?.type === 'enum' && { enumValues: enums.get(field.enum) }),
          ...(field && 'minLength' in field && { minLength: field.minLength }),
          ...(field && 'maxLength' in field && { maxLength: field.maxLength }),
          ...(field && 'minimum' in field && { minimum: field.minimum }),
          ...(field && 'maximum' in field && { maximum: field.maximum }),
          ...(field?.type === 'decimal' && { precision: field.precision, scale: field.scale }),
        }]]
      }))]
    })),
  }
}
