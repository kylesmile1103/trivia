// Model operation payloads and draft handlers (LLD-08 §4). The owning batch checks baseRev.
import { z } from 'zod'

import { refuse, type Draft } from '../apply/draft.js'
import type { MODEL_DOC } from '../types/ops.js'
import { SCHEMA_URL } from '../types/common.js'
import {
  entityApiSchema, entitySchema, enumSchema, fieldSchema, modelIndexSchema, modelMemberName,
  modelNamespace, modelSchema, modelTypeName, relationSchema,
  type ModelDoc, type ModelEntity, type ModelField,
} from './types.js'

const modelOp = {
  doc: z.literal('model.blueprint.json' satisfies typeof MODEL_DOC),
  baseRev: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
}
const onEntity = { ...modelOp, entity: modelTypeName }
const entityPatchSchema = entitySchema.omit({ renamedFrom: true }).partial({
  plural: true, key: true, fields: true, relations: true, indexes: true, api: true,
})

export const modelOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('setModel'), ...modelOp, namespace: modelNamespace }),
  z.strictObject({ op: z.literal('setEnum'), ...modelOp, enum: enumSchema }),
  z.strictObject({ op: z.literal('removeEnum'), ...modelOp, name: modelTypeName }),
  z.strictObject({ op: z.literal('setEntity'), ...modelOp, entity: entityPatchSchema }),
  z.strictObject({ op: z.literal('removeEntity'), ...onEntity }),
  z.strictObject({ op: z.literal('renameEntity'), ...onEntity, name: modelTypeName }),
  z.strictObject({ op: z.literal('setField'), ...onEntity, field: fieldSchema }),
  z.strictObject({ op: z.literal('removeField'), ...onEntity, field: modelMemberName }),
  z.strictObject({ op: z.literal('renameField'), ...onEntity, field: modelMemberName, name: modelMemberName }),
  z.strictObject({ op: z.literal('moveField'), ...onEntity, field: modelMemberName, index: z.int().min(0) }),
  z.strictObject({ op: z.literal('setRelation'), ...onEntity, relation: relationSchema }),
  z.strictObject({ op: z.literal('removeRelation'), ...onEntity, relation: modelMemberName }),
  z.strictObject({ op: z.literal('setIndexes'), ...onEntity, indexes: z.array(modelIndexSchema) }),
  z.strictObject({ op: z.literal('setEntityApi'), ...onEntity, api: entityApiSchema }),
])

export type ModelOp = z.output<typeof modelOpSchema>

type Named = { name: string }
type Renamable = Named & { renamedFrom?: string | undefined }

function upsert<T extends Named>(list: T[], value: T): void {
  const index = list.findIndex((item) => item.name === value.name)
  if (index < 0) list.push(value)
  else list[index] = value
}

function requireIndex(list: readonly Named[], name: string, kind: string): number {
  const index = list.findIndex((item) => item.name === name)
  if (index < 0) refuse('invalid_op', `No ${kind} named "${name}"`, { name })
  return index
}

function rename(item: Renamable, name: string, peers: readonly Named[]): void {
  if (name === item.name) return
  if (peers.some((peer) => peer !== item && peer.name.toLowerCase() === name.toLowerCase())) {
    refuse('conflict', `The name "${name}" is already in use`, { name })
  }
  const origin = item.renamedFrom ?? item.name
  item.name = name
  if (origin === name) delete item.renamedFrom
  else item.renamedFrom = origin
}

function keepFieldOrigin(field: ModelField, previous: readonly ModelField[]): ModelField {
  const origin = previous.find((entry) => entry.name === field.name)?.renamedFrom
  return origin === undefined ? field : { ...field, renamedFrom: origin }
}

function setEntity(model: ModelDoc, patch: z.output<typeof entityPatchSchema>): void {
  const existing = model.entities.find((entity) => entity.name === patch.name)
  if (!existing && (patch.plural === undefined || patch.key === undefined)) {
    refuse('invalid_op', `Creating ${patch.name} requires a plural and key`, { entity: patch.name })
  }
  const { fields, ...rest } = patch
  const defined = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined))
  upsert(model.entities, entitySchema.parse({
    fields: [], relations: [], indexes: [], api: { operations: [] },
    ...existing,
    ...defined,
    ...(fields !== undefined ? { fields: fields.map((field) => keepFieldOrigin(field, existing?.fields ?? [])) } : {}),
  }))
}

function refuseReferences(name: string, references: string[]): void {
  if (references.length > 0) {
    refuse('invalid_result', `Cannot remove ${name}; referenced by ${references.join(', ')}`, { name, references })
  }
}

function removeEnum(model: ModelDoc, name: string): void {
  const index = requireIndex(model.enums, name, 'enum')
  const references: string[] = []
  const usesEnum = (field: ModelField) => field.type === 'enum' && field.enum === name
  for (const entity of model.entities) {
    for (const field of entity.fields.filter(usesEnum)) references.push(`${entity.name}.${field.name}`)
    for (const operation of entity.api.custom ?? []) {
      for (const field of (operation.input ?? []).filter(usesEnum)) references.push(`${entity.name}.${operation.name}.${field.name}`)
    }
  }
  refuseReferences(name, references)
  model.enums.splice(index, 1)
}

function removeEntity(model: ModelDoc, entity: ModelEntity, index: number): void {
  const references: string[] = []
  for (const owner of model.entities) {
    if (owner === entity) continue
    for (const relation of owner.relations) if (relation.to === entity.name) references.push(`${owner.name}.${relation.name}`)
    for (const operation of owner.api.custom ?? []) {
      if (operation.returns === entity.name) references.push(`${owner.name}.${operation.name}.returns`)
    }
  }
  refuseReferences(entity.name, references)
  model.entities.splice(index, 1)
}

function renameEntity(model: ModelDoc, entity: ModelEntity, name: string): void {
  const previous = entity.name
  rename(entity, name, [...model.entities, ...model.enums])
  for (const owner of model.entities) {
    for (const relation of owner.relations) if (relation.to === previous) relation.to = name
    for (const operation of owner.api.custom ?? []) if (operation.returns === previous) operation.returns = name
  }
}

function renameField(entity: ModelEntity, from: string, name: string): void {
  const field = entity.fields[requireIndex(entity.fields, from, 'field')]!
  rename(field, name, [...entity.fields, ...entity.relations, entity.key])
  const renamed = (fieldName: string) => fieldName === from ? name : fieldName
  for (const index of entity.indexes) index.fields = index.fields.map(renamed)
  for (const list of ['filterable', 'sortable', 'searchable'] as const) {
    if (entity.api[list] !== undefined) entity.api[list] = entity.api[list].map(renamed)
  }
}

type EntityOp = Extract<ModelOp, { entity: string }>

function applyEntityOp(model: ModelDoc, op: EntityOp): void {
  const index = requireIndex(model.entities, op.entity, 'entity')
  const entity = model.entities[index]!
  switch (op.op) {
    case 'removeEntity': return removeEntity(model, entity, index)
    case 'renameEntity': return renameEntity(model, entity, op.name)
    case 'setField': return upsert(entity.fields, keepFieldOrigin(op.field, entity.fields))
    case 'removeField': {
      entity.fields.splice(requireIndex(entity.fields, op.field, 'field'), 1)
      return
    }
    case 'renameField': return renameField(entity, op.field, op.name)
    case 'moveField': {
      const current = requireIndex(entity.fields, op.field, 'field')
      if (op.index >= entity.fields.length) refuse('invalid_op', `Field index ${op.index} is past the end of ${op.entity}.fields`)
      const [field] = entity.fields.splice(current, 1)
      entity.fields.splice(op.index, 0, field!)
      return
    }
    case 'setRelation': return upsert(entity.relations, op.relation)
    case 'removeRelation': {
      entity.relations.splice(requireIndex(entity.relations, op.relation, 'relation'), 1)
      return
    }
    case 'setIndexes': {
      entity.indexes = op.indexes
      return
    }
    case 'setEntityApi': {
      entity.api = op.api
      return
    }
  }
}

export function applyModelOp(draft: Draft, op: ModelOp): void {
  if (op.op === 'setModel' && !draft.has(op.doc)) {
    draft.put(op.doc, { $schema: SCHEMA_URL.model, blueprintVersion: 1, namespace: op.namespace, enums: [], entities: [] })
    return
  }
  const model = modelSchema.safeParse(draft.edit(op.doc))
  if (!model.success) refuse('invalid_op', `${op.doc} does not match the model v1 schema; fix the file first`)
  switch (op.op) {
    case 'setModel': model.data.namespace = op.namespace; break
    case 'setEnum': upsert(model.data.enums, op.enum); break
    case 'removeEnum': removeEnum(model.data, op.name); break
    case 'setEntity': setEntity(model.data, op.entity); break
    default: applyEntityOp(model.data, op)
  }
  draft.put(op.doc, model.data)
}
