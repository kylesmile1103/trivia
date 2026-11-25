// Model-specific checks after the document passes the schema (LLD-08 §5).
import { z } from 'zod'

import { toPointer, type Diagnostic } from '../types/diagnostics.js'
import { MODEL_DOC } from '../types/ops.js'
import csharp from './reserved/csharp.json' with { type: 'json' }
import generator from './reserved/generator.json' with { type: 'json' }
import postgres from './reserved/postgres.json' with { type: 'json' }
import type { ModelDoc, ModelEntity, ModelField, ModelFieldType, ModelRelation } from './types.js'

type Path = readonly PropertyKey[]
interface SetRelationFix {
  op: 'setRelation'
  doc: typeof MODEL_DOC
  baseRev: string
  entity: string
  relation: Extract<ModelRelation, { kind: 'belongsTo' }>
}
export interface ModelDiagnostic extends Omit<Diagnostic, 'hint'> {
  hint?: { ops?: SetRelationFix[]; text?: string }
}
type Report = (code: string, path: Path, message: string, hint?: ModelDiagnostic['hint']) => void

const csharpKeywords = new Set(csharp.words)
const postgresKeywords = new Set(postgres.words)
const generatorNames = new Set(generator.words)

function sqlName(name: string): string {
  return name.replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2').replaceAll('-', '_').toLowerCase()
}

function reservedBy(name: string, key = false): string | undefined {
  const folded = name.toLowerCase()
  if (csharpKeywords.has(folded)) return 'C#'
  if (postgresKeywords.has(sqlName(name))) return 'PostgreSQL'
  if (generatorNames.has(folded) && !(key && folded === 'id')) return 'the generator'
  return undefined
}

function claim(name: string, path: Path, seen: Set<string>, report: Report): void {
  const folded = name.toLowerCase()
  if (seen.has(folded)) report('duplicate_name', path, `The name "${name}" is already in use`)
  else seen.add(folded)
}

function checkName(name: string, path: Path, report: Report, key = false): void {
  const source = reservedBy(name, key)
  if (source) report('reserved_name', path, `"${name}" is reserved by ${source}`)
}

const email = z.email()
const uri = z.url()
const uuid = z.uuid()
const int = z.int32()
const long = z.int()
const date = z.iso.date()
const datetime = z.iso.datetime({ offset: true })

/** Check against SQL numeric(p,s) using the decimal digits that the JSON writer emits. */
function fitsDecimal(value: number, precision: number, scale: number): boolean {
  if (value === 0) return true
  const [mantissa = '', exponent = '0'] = Math.abs(value).toString().split('e')
  const [whole = '', fraction = ''] = mantissa.split('.')
  const leadingZeros = (whole + fraction).match(/^0*/)?.[0].length ?? 0
  const shift = Number(exponent)
  const integerDigits = Math.max(0, whole.length + shift - leadingZeros)
  const fractionalDigits = Math.max(0, fraction.length - shift)
  return integerDigits <= precision - scale && fractionalDigits <= scale
}

function defaultProblem(field: ModelField, enums: ReadonlyMap<string, readonly string[]>, pattern?: RegExp): string | undefined {
  const value = field.default
  if (value === undefined) return undefined
  if (value === null) return field.required ? 'a required field cannot default to null' : undefined
  switch (field.type) {
    case 'string':
    case 'text': {
      if (typeof value !== 'string') return 'expected a string'
      const length = [...value].length
      if (field.minLength !== undefined && length < field.minLength) return `shorter than minLength ${field.minLength}`
      if (field.maxLength !== undefined && length > field.maxLength) return `longer than maxLength ${field.maxLength}`
      if (pattern && !pattern.test(value)) return 'does not match pattern'
      if (field.format === 'email' && !email.safeParse(value).success) return 'expected an email address'
      if (field.format === 'uri' && (/\s/u.test(value) || !uri.safeParse(value).success)) return 'expected an absolute URI'
      return undefined
    }
    case 'int':
    case 'long':
    case 'decimal': {
      if (typeof value !== 'number') return 'expected a number'
      if (field.type === 'int' && !int.safeParse(value).success) return 'expected a signed 32-bit integer'
      if (field.type === 'long' && !long.safeParse(value).success) return 'expected a safe JSON integer'
      if (field.minimum !== undefined && value < field.minimum) return `less than minimum ${field.minimum}`
      if (field.maximum !== undefined && value > field.maximum) return `greater than maximum ${field.maximum}`
      if (field.type === 'decimal' && !fitsDecimal(value, field.precision, field.scale)) {
        return `does not fit decimal precision ${field.precision} and scale ${field.scale}`
      }
      return undefined
    }
    case 'bool': return typeof value === 'boolean' ? undefined : 'expected a boolean'
    case 'uuid': return uuid.safeParse(value).success ? undefined : 'expected a UUID'
    case 'date': return typeof value === 'string' && !value.startsWith('0000-') && date.safeParse(value).success
      ? undefined : 'expected a calendar date (YYYY-MM-DD)'
    case 'datetime': return typeof value === 'string' && !value.startsWith('0000-') && datetime.safeParse(value).success
      ? undefined : 'expected a date-time with an offset'
    case 'enum': {
      const values = enums.get(field.enum)
      return typeof value === 'string' && (values === undefined || values.includes(value))
        ? undefined : `expected a value of ${field.enum}`
    }
    case 'json': return undefined
  }
}

function checkField(field: ModelField, path: Path, enums: ReadonlyMap<string, readonly string[]>, report: Report): void {
  let pattern: RegExp | undefined
  if (field.type === 'string' || field.type === 'text') {
    if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) {
      report('invalid_constraint', [...path, 'maxLength'], 'maxLength must be at least minLength')
      return
    }
    if (field.pattern !== undefined) {
      try {
        pattern = new RegExp(field.pattern, 'u')
      } catch {
        report('invalid_constraint', [...path, 'pattern'], 'pattern must be a valid regular expression')
        return
      }
    }
  }
  if (field.type === 'int' || field.type === 'long' || field.type === 'decimal') {
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) {
      report('invalid_constraint', [...path, 'maximum'], 'maximum must be at least minimum')
      return
    }
    if (field.type === 'decimal' && field.scale > field.precision) {
      report('invalid_constraint', [...path, 'scale'], 'scale must be at most precision')
      return
    }
  }
  const problem = defaultProblem(field, enums, pattern)
  if (problem) report('invalid_default', [...path, 'default'], `Invalid default for ${field.name}: ${problem}`)
}

/** The key, stored fields and implied foreign keys exposed to indexes and the flat API. */
export function modelFieldTypes(entity: ModelEntity, entities: ReadonlyMap<string, ModelEntity>): Map<string, ModelFieldType | undefined> {
  const fields = new Map<string, ModelFieldType | undefined>([[entity.key.name, entity.key.type]])
  for (const field of entity.fields) if (!fields.has(field.name)) fields.set(field.name, field.type)
  for (const relation of entity.relations) {
    if (relation.kind === 'belongsTo' && !fields.has(relation.foreignKey)) {
      fields.set(relation.foreignKey, entities.get(relation.to)?.key.type)
    }
  }
  return fields
}

function inverseHint(entity: ModelEntity, target: ModelEntity, foreignKey: string, baseRev: string): ModelDiagnostic['hint'] {
  const taken = new Set([
    target.key.name, ...target.fields.map((field) => field.name),
    ...target.relations.flatMap((relation) => relation.kind === 'belongsTo' ? [relation.name, relation.foreignKey] : [relation.name]),
  ].map((name) => name.toLowerCase()))
  if (reservedBy(foreignKey) || taken.has(foreignKey.toLowerCase())) {
    return { text: `Free the name "${foreignKey}" on ${target.name} before adding its belongsTo relation` }
  }
  taken.add(foreignKey.toLowerCase())
  const base = foreignKey.endsWith('Id') ? foreignKey.slice(0, -2) : entity.name[0]!.toLowerCase() + entity.name.slice(1)
  let name = base
  for (let suffix = 1; taken.has(name.toLowerCase()) || reservedBy(name); suffix++) {
    name = `${base}Relation${suffix === 1 ? '' : suffix}`
  }
  return { ops: [{
    op: 'setRelation', doc: MODEL_DOC, baseRev, entity: target.name,
    relation: { name, kind: 'belongsTo', to: entity.name, foreignKey },
  }] }
}

function checkEntityReferences(
  entity: ModelEntity,
  path: Path,
  entities: ReadonlyMap<string, ModelEntity>,
  enums: ReadonlyMap<string, readonly string[]>,
  baseRev: string,
  report: Report,
): void {
  const checkEnum = (field: ModelField, fieldPath: Path) => {
    if (field.type === 'enum' && !enums.has(field.enum)) {
      report('dangling_reference', [...fieldPath, 'enum'], `No enum named "${field.enum}"`)
    }
  }
  entity.fields.forEach((field, i) => checkEnum(field, [...path, 'fields', i]))

  const memberNames = new Map<string, string>([[entity.key.name.toLowerCase(), entity.key.name]])
  for (const field of entity.fields) memberNames.set(field.name.toLowerCase(), field.name)
  for (const relation of entity.relations) memberNames.set(relation.name.toLowerCase(), relation.name)

  entity.relations.forEach((relation, i) => {
    const relationPath = [...path, 'relations', i]
    const target = entities.get(relation.to)
    if (!target) report('dangling_reference', [...relationPath, 'to'], `No entity named "${relation.to}"`)
    if (relation.kind === 'belongsTo') {
      const fkPath = [...relationPath, 'foreignKey']
      const folded = relation.foreignKey.toLowerCase()
      const member = memberNames.get(folded)
      if (member !== undefined) {
        const type = target ? ` of type ${target.key.type}` : ''
        report('invalid_constraint', fkPath, `The implied foreign key "${relation.foreignKey}"${type} collides with "${member}" on ${entity.name}`)
      } else {
        checkName(relation.foreignKey, fkPath, report)
        memberNames.set(folded, relation.foreignKey)
      }
      if (relation.required && relation.onDelete === 'setNull') {
        report('invalid_constraint', [...relationPath, 'onDelete'], 'setNull requires a nullable foreign key')
      }
    } else if (target && !target.relations.some((candidate) =>
      candidate.kind === 'belongsTo' && candidate.to === entity.name && candidate.foreignKey === relation.foreignKey)) {
      report('unmatched_relation', [...relationPath, 'foreignKey'],
        `${target.name} needs a belongsTo relation to ${entity.name} with foreign key "${relation.foreignKey}"`,
        inverseHint(entity, target, relation.foreignKey, baseRev))
    }
  })

  const fields = modelFieldTypes(entity, entities)
  const checkFieldRef = (name: string, fieldPath: Path) => {
    if (!fields.has(name)) report('dangling_reference', fieldPath, `No field named "${name}" on ${entity.name}`)
  }
  entity.indexes.forEach((index, i) => index.fields.forEach((field, j) => checkFieldRef(field, [...path, 'indexes', i, 'fields', j])))
  for (const list of ['filterable', 'sortable', 'searchable'] as const) {
    entity.api[list]?.forEach((field, i) => checkFieldRef(field, [...path, 'api', list, i]))
  }
  entity.api.custom?.forEach((operation, i) => {
    const opPath = [...path, 'api', 'custom', i]
    operation.input?.forEach((field, j) => checkEnum(field, [...opPath, 'input', j]))
    if (operation.returns !== undefined && !entities.has(operation.returns)) {
      report('dangling_reference', [...opPath, 'returns'], `No entity named "${operation.returns}"`)
    }
  })
}

export function validateModel(model: ModelDoc, baseRev: string): ModelDiagnostic[] {
  const diagnostics: ModelDiagnostic[] = []
  const report: Report = (code, path, message, hint) => {
    diagnostics.push({ code, severity: 'error', doc: MODEL_DOC, pointer: toPointer(path), message, ...(hint ? { hint } : {}) })
  }
  for (const part of model.namespace.split('.')) {
    if (csharpKeywords.has(part.toLowerCase())) report('reserved_name', ['namespace'], `"${part}" is reserved by C#`)
  }

  const names = new Set<string>()
  const enums = new Map<string, readonly string[]>()
  model.enums.forEach((entry, index) => {
    const namePath = ['enums', index, 'name']
    claim(entry.name, namePath, names, report)
    checkName(entry.name, namePath, report)
    if (!enums.has(entry.name)) enums.set(entry.name, entry.values)
    const values = new Set<string>()
    entry.values.forEach((value, valueIndex) => {
      if (values.has(value)) report('duplicate_name', ['enums', index, 'values', valueIndex], `"${value}" is already a value of ${entry.name}`)
      values.add(value)
    })
  })

  const entities = new Map<string, ModelEntity>()
  for (const entity of model.entities) if (!entities.has(entity.name)) entities.set(entity.name, entity)

  model.entities.forEach((entity, index) => {
    const path = ['entities', index]
    claim(entity.name, [...path, 'name'], names, report)
    checkName(entity.name, [...path, 'name'], report)
    checkName(entity.plural, [...path, 'plural'], report)
    checkName(entity.key.name, [...path, 'key', 'name'], report, true)

    const members = new Set<string>()
    const checkMember = (name: string, memberPath: Path) => {
      claim(name, memberPath, members, report)
      if (name.toLowerCase() === entity.key.name.toLowerCase()) {
        report('reserved_name', memberPath, `"${name}" collides with the key of ${entity.name}`)
      } else checkName(name, memberPath, report)
    }
    entity.fields.forEach((field, i) => {
      const fieldPath = [...path, 'fields', i]
      checkMember(field.name, [...fieldPath, 'name'])
      checkField(field, fieldPath, enums, report)
    })
    entity.relations.forEach((relation, i) => {
      checkMember(relation.name, [...path, 'relations', i, 'name'])
    })

    const operations = new Set<string>()
    entity.api.custom?.forEach((operation, i) => {
      const operationPath = [...path, 'api', 'custom', i]
      claim(operation.name, [...operationPath, 'name'], operations, report)
      checkName(operation.name, [...operationPath, 'name'], report)
      const inputs = new Set<string>()
      operation.input?.forEach((field, j) => {
        const inputPath = [...operationPath, 'input', j]
        claim(field.name, [...inputPath, 'name'], inputs, report)
        checkName(field.name, [...inputPath, 'name'], report)
        checkField(field, inputPath, enums, report)
      })
    })
    checkEntityReferences(entity, path, entities, enums, baseRev, report)
  })
  return diagnostics
}
