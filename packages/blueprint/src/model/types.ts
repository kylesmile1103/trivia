// Model document shapes (LLD-08 §1–3). Cross-field rules and references are checked separately.
import { z } from 'zod'

import { PAGE_NAME, SCHEMA_URL, SLOT, TOKEN, json } from '../types/common.js'

export const modelTypeName = z.string().regex(PAGE_NAME)
export const modelMemberName = z.string().regex(SLOT)
export const modelNamespace = z.string().regex(/^[A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)*$/)

export const enumSchema = z.strictObject({
  name: modelTypeName,
  values: z.array(z.string().min(1)).min(1),
})

const key = { name: modelMemberName }
export const keySchema = z.discriminatedUnion('type', [
  z.strictObject({ ...key, type: z.literal('uuid'), generated: z.literal('v7').optional() }),
  z.strictObject({ ...key, type: z.enum(['int', 'long']) }),
])

const commonField = {
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  default: json.optional(),
  description: z.string().optional(),
}
const lengthConstraints = {
  minLength: z.int().min(0).optional(),
  maxLength: z.int().min(1).optional(),
  pattern: z.string().optional(),
  format: z.enum(['email', 'uri', 'password']).optional(),
}

export const fieldSchema = z.discriminatedUnion('type', [
  z.strictObject({ name: modelMemberName, type: z.enum(['string', 'text']), ...commonField, ...lengthConstraints, renamedFrom: modelMemberName.optional() }),
  z.strictObject({
    name: modelMemberName, type: z.literal('int'), ...commonField,
    minimum: z.int32().optional(), maximum: z.int32().optional(), renamedFrom: modelMemberName.optional(),
  }),
  z.strictObject({
    name: modelMemberName, type: z.literal('long'), ...commonField,
    minimum: z.int().optional(), maximum: z.int().optional(), renamedFrom: modelMemberName.optional(),
  }),
  z.strictObject({
    name: modelMemberName, type: z.literal('decimal'), ...commonField,
    precision: z.int().min(1), scale: z.int().min(0), minimum: z.number().optional(), maximum: z.number().optional(),
    renamedFrom: modelMemberName.optional(),
  }),
  z.strictObject({ name: modelMemberName, type: z.enum(['bool', 'date', 'uuid', 'json']), ...commonField, renamedFrom: modelMemberName.optional() }),
  z.strictObject({
    name: modelMemberName, type: z.literal('datetime'), ...commonField,
    generated: z.enum(['onCreate', 'onUpdate']).optional(), renamedFrom: modelMemberName.optional(),
  }),
  z.strictObject({ name: modelMemberName, type: z.literal('enum'), enum: modelTypeName, ...commonField, renamedFrom: modelMemberName.optional() }),
])

const foreignKey = { to: modelTypeName, foreignKey: modelMemberName }
export const relationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    name: modelMemberName,
    kind: z.literal('belongsTo'),
    ...foreignKey,
    required: z.boolean().optional(),
    onDelete: z.enum(['restrict', 'cascade', 'setNull']).optional(),
  }),
  z.strictObject({ name: modelMemberName, kind: z.literal('hasMany'), ...foreignKey }),
])

export const modelIndexSchema = z.strictObject({
  fields: z.array(modelMemberName).min(1),
  unique: z.boolean().optional(),
})

const routeSegment = '(?:\\{[a-z][A-Za-z0-9]*\\}|(?!\\.{1,2}(?:/|$))[A-Za-z0-9._~-]+)'
export const customOperationSchema = z.strictObject({
  name: modelMemberName,
  method: z.string().regex(/^[A-Z]+$/),
  path: z.string().regex(new RegExp(`^(?:${routeSegment}(?:/${routeSegment})*)?$`)),
  input: z.array(fieldSchema).optional(),
  returns: modelTypeName.optional(),
})

export const entityApiSchema = z.strictObject({
  operations: z.array(z.enum(['list', 'get', 'create', 'update', 'delete'])),
  filterable: z.array(modelMemberName).optional(),
  sortable: z.array(modelMemberName).optional(),
  searchable: z.array(modelMemberName).optional(),
  custom: z.array(customOperationSchema).optional(),
})

export const entitySchema = z.strictObject({
  name: modelTypeName,
  plural: z.string().regex(TOKEN),
  key: keySchema,
  fields: z.array(fieldSchema),
  relations: z.array(relationSchema),
  indexes: z.array(modelIndexSchema),
  api: entityApiSchema,
  concurrency: z.boolean().optional(),
  renamedFrom: modelTypeName.optional(),
})

export const modelSchema = z.strictObject({
  $schema: z.literal(SCHEMA_URL.model),
  blueprintVersion: z.literal(1),
  namespace: modelNamespace,
  enums: z.array(enumSchema),
  entities: z.array(entitySchema),
})

export type ModelDoc = z.output<typeof modelSchema>
export type ModelEntity = z.output<typeof entitySchema>
export type ModelField = z.output<typeof fieldSchema>
export type ModelFieldType = ModelField['type']
export type ModelKey = z.output<typeof keySchema>
export type ModelRelation = z.output<typeof relationSchema>
