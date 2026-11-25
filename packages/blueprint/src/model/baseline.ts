import { z } from 'zod'

import { toPointer, type Diagnostic } from '../types/diagnostics.js'
import { MODEL_DOC } from '../types/ops.js'

import { MODEL_MAPPING } from './mapping.js'
import { modelMemberName, modelTypeName, type ModelDoc, type ModelEntity, type ModelFieldType } from './types.js'
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

type FieldSummary = z.infer<typeof modelFieldSummary>

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

function narrowed(before: FieldSummary, after: FieldSummary): boolean {
  const widening = (before.type === 'int' && after.type === 'long') ||
    (before.type === 'string' && after.type === 'text')
  if (before.type !== after.type && !widening) return true
  if (before.enumValues?.some((value) => !after.enumValues?.includes(value))) return true
  if ((after.minLength ?? 0) > (before.minLength ?? 0) ||
      (after.maxLength ?? Infinity) < (before.maxLength ?? Infinity) ||
      (after.minimum ?? -Infinity) > (before.minimum ?? -Infinity) ||
      (after.maximum ?? Infinity) < (before.maximum ?? Infinity)) return true

  if (before.precision !== undefined && before.scale !== undefined &&
      after.precision !== undefined && after.scale !== undefined) {
    return after.scale < before.scale || after.precision - after.scale < before.precision - before.scale
  }
  return false
}

function fieldPointer(entity: ModelEntity, index: number, name: string): PropertyKey[] {
  if (name === entity.key.name) return ['entities', index, 'key']
  const field = entity.fields.findIndex((entry) => entry.name === name)
  if (field !== -1) return ['entities', index, 'fields', field]
  const relation = entity.relations.findIndex((entry) => entry.kind === 'belongsTo' && entry.foreignKey === name)
  return ['entities', index, 'relations', relation]
}

export function breakingModelChanges(model: ModelDoc, rev: string, baseline: ModelBaseline): Diagnostic[] {
  if (rev === baseline.rev) return []
  const current = summarizeModel(model, rev)
  const diagnostics: Diagnostic[] = []
  const report = (pointer: PropertyKey[], message: string) => diagnostics.push({
    code: 'breaking_change', severity: 'warning', doc: MODEL_DOC, pointer: toPointer(pointer), message,
  })
  for (const [name, previous] of Object.entries(baseline.entities)) {
    const index = model.entities.findIndex((entity) => entity.name === name)
    if (index === -1) {
      report(['entities'], 'Removed generated entity ' + name + '.')
      continue
    }
    const entity = model.entities[index]!
    const fields = current.entities[name]!
    for (const field of Object.keys(previous)) {
      if (!Object.hasOwn(fields, field)) report(['entities', index, 'fields'], 'Removed generated field ' + name + '.' + field + '.')
    }
    for (const [field, value] of Object.entries(fields)) {
      const old = Object.hasOwn(previous, field) ? previous[field] : undefined
      const label = name + '.' + field
      if (old && narrowed(old, value)) {
        report(fieldPointer(entity, index, field), 'Narrowed the accepted values for ' + label + '.')
      }
      if (value.required && !value.hasDefault && (!old || !old.required || old.hasDefault)) {
        report(fieldPointer(entity, index, field), label + ' is required without a default and existing rows need a value.')
      }
    }
  }
  return diagnostics
}
