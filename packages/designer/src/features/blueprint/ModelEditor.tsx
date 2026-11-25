import { useState, type FormEvent } from 'react'

import { MODEL_DOC, MODEL_FIELD_TYPES } from '@/shared/engine/blueprint-types'
import type {
  BlueprintDiagnostic, BlueprintDocument, BlueprintModel, BlueprintOp, BlueprintPatchResult,
  ModelApi, ModelEntity, ModelField, ModelRelation,
} from '@/shared/engine/types'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

import { CommitInput, Field, JsonField, selectClass } from './fields'

interface ModelEditorProps {
  document?: BlueprintDocument<BlueprintModel>
  appName: string
  diagnostics: BlueprintDiagnostic[]
  rejected?: { ops: BlueprintOp[]; diagnostics: BlueprintDiagnostic[] }
  busy?: boolean
  commit(ops: BlueprintOp[], label: string): Promise<BlueprintPatchResult | null>
}

type ModelOp = Extract<BlueprintOp, { doc: typeof MODEL_DOC }>
type Change<T = ModelOp> = T extends ModelOp ? Omit<T, 'doc' | 'baseRev'> : never
type Save = (op: Change, label: string) => Promise<boolean>
type Finding = BlueprintDiagnostic & { fix?: BlueprintOp[] }

const MEMBER = '[a-z][A-Za-z0-9]*'
const TYPE = '[A-Z][A-Za-z0-9]*'
const API_OPERATIONS = ['list', 'get', 'create', 'update', 'delete'] as const
const formText = (form: FormData, name: string) => String(form.get(name) ?? '').trim()
function duplicate(form: HTMLFormElement, inputName: string, name: string, records: ReadonlyArray<{ name: string }>): boolean {
  if (!records.some((record) => record.name.toLowerCase() === name.toLowerCase())) return false
  const input = form.elements.namedItem(inputName)
  if (input instanceof HTMLInputElement) {
    input.setCustomValidity(`The name "${name}" is already in use.`)
    input.reportValidity()
  }
  return true
}

function clearValidity(event: FormEvent<HTMLInputElement>) {
  event.currentTarget.setCustomValidity('')
}

const under = (findings: Finding[], pointer: string) => findings.filter((item) => item.pointer === pointer || item.pointer.startsWith(pointer + '/'))

function repair(
  diagnostic: BlueprintDiagnostic, rev: string | null, rejected: ModelEditorProps['rejected'],
): BlueprintOp[] | undefined {
  const ops = diagnostic.hint?.ops
  if (!ops?.length) return undefined
  if (!rejected?.diagnostics.includes(diagnostic)) return ops
  // A refused write's hint uses the proposed document revision. A missing inverse is
  // repaired by retrying the proposal with its inverse in one batch, guarded by the read rev.
  const [request] = rejected.ops
  if (diagnostic.code !== 'unmatched_relation' || rejected.ops.length !== 1 ||
    request?.op !== 'setRelation' || request.baseRev !== rev || !ops.every((op) => op.op === 'setRelation' && op.doc === MODEL_DOC)) return undefined
  return [request, ...ops.map((op) => ({ ...op, baseRev: rev }))]
}

function Findings({ items, apply }: { items: Finding[]; apply(ops: BlueprintOp[]): void }) {
  if (!items.length) return null
  return (
    <ul className="space-y-1 text-xs">
      {items.map(({ message, hint, severity, pointer, fix }, index) => (
        <li key={pointer + ':' + index} className="space-y-1 [overflow-wrap:anywhere]">
          <p className={severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{message}</p>
          {hint?.text && <p className="text-muted-foreground">{hint.text}</p>}
          {fix && <Button type="button" size="xs" variant="outline" onClick={() => apply(fix)}>Apply fix</Button>}
        </li>
      ))}
    </ul>
  )
}

export function ModelEditor({ document, appName, diagnostics, rejected, busy = false, commit }: ModelEditorProps) {
  const [selected, setSelected] = useState('')
  const model = document?.doc
  const rev = document?.rev ?? null
  const locations = [...diagnostics, ...(rejected?.diagnostics ?? [])].filter((item) => item.doc === MODEL_DOC)
  const findings = locations.map((item) => ({ ...item, fix: repair(item, rev, rejected) }))
  const applyFix = (ops: BlueprintOp[]) => void commit(ops, 'Blueprint: fix model diagnostic')
  const save: Save = async (op, label) => {
    const result = await commit([{ ...op, doc: MODEL_DOC, baseRev: rev }], 'Blueprint: ' + label)
    return result !== null
  }
  const entity = model?.entities.find(({ name }) => name === selected) ?? model?.entities[0]
  const entityPointer = model && entity ? '/entities/' + model.entities.indexOf(entity) : ''
  const otherFindings = findings.filter((item) => !entityPointer || !item.pointer.startsWith(entityPointer + '/'))

  return (
    <section aria-label="Data model" className="space-y-3">
      <h2 className="text-xs font-semibold">Data model</h2>
      {!model ? (
        <form onSubmit={(event) => {
          event.preventDefault()
          const namespace = formText(new FormData(event.currentTarget), 'namespace')
          void save({ op: 'setModel', namespace }, 'create model')
        }}>
          <fieldset disabled={busy} className="grid min-w-0 gap-2">
            <Field label="Namespace">{(id) => <Input id={id} name="namespace" data-pointer="/namespace" defaultValue={appName} required />}</Field>
            <Findings items={findings} apply={applyFix} />
            <Button type="submit" size="sm">Create model</Button>
          </fieldset>
        </form>
      ) : (
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          <Field label="Namespace">{(id) => (
            <CommitInput id={id} data-pointer="/namespace" value={model.namespace} commit={(namespace) => void save({ op: 'setModel', namespace }, 'set model namespace')} />
          )}</Field>
          <Findings items={otherFindings} apply={applyFix} />
          {entity && (
            <Field label="Entity">{(id) => (
              <select id={id} className={selectClass} value={entity.name} onChange={(event) => setSelected(event.target.value)}>
                {model.entities.map(({ name }) => <option key={name}>{name}</option>)}
              </select>
            )}</Field>
          )}
          <AddEntity existing={[...model.entities, ...model.enums]} pointer={'/entities/' + model.entities.length} save={save} onSelect={setSelected} />
          {entity && (
            <EntityEditor
              key={entity.name} entity={entity} pointer={entityPointer} model={model} save={save} onSelect={setSelected}
              findings={under(findings, entityPointer)} applyFix={applyFix}
            />
          )}
        </fieldset>
      )}
    </section>
  )
}

function AddEntity({ pointer, existing, save, onSelect }: { pointer: string; existing: ReadonlyArray<{ name: string }>; save: Save; onSelect(name: string): void }) {
  return (
    <details className="space-y-2 text-xs">
      <summary className="cursor-pointer font-medium">Add entity</summary>
      <form aria-label="Add entity" className="grid gap-2" onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        const fields = new FormData(form)
        const name = formText(fields, 'entityName')
        if (duplicate(form, 'entityName', name, existing)) return
        const plural = formText(fields, 'plural') || name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() + 's'
        void save({ op: 'setEntity', entity: { name, plural, key: { name: 'id', type: 'uuid' } } }, 'add entity ' + name).then((ok) => {
          if (ok) { form.reset(); onSelect(name) }
        })
      }}>
        <Field label="Entity name">{(id) => <Input id={id} name="entityName" onInput={clearValidity} data-pointer={pointer + '/name'} pattern={TYPE} required />}</Field>
        <Field label="Plural route segment">{(id) => <Input id={id} name="plural" data-pointer={pointer + '/plural'} placeholder="Derived from the name" />}</Field>
        <Button type="submit" size="xs" variant="outline">Add entity</Button>
      </form>
    </details>
  )
}

function EntityEditor({ entity, pointer, model, save, onSelect, findings, applyFix }: {
  entity: ModelEntity
  pointer: string
  model: BlueprintModel
  save: Save
  onSelect(name: string): void
  findings: Finding[]
  applyFix(ops: BlueprintOp[]): void
}) {
  const { name } = entity
  const findingsFor = (suffix: string) => <Findings items={under(findings, pointer + suffix)} apply={applyFix} />
  const saveField = (field: ModelField) => save({ op: 'setField', entity: name, field }, `set ${field.name} on ${name}`)
  const saveRelation = (relation: ModelRelation) => save({ op: 'setRelation', entity: name, relation }, `set ${relation.name} on ${name}`)
  const enums = model.enums.map((item) => item.name)
  const targets = model.entities.map((item) => item.name)

  return (
    <section aria-label={name + ' entity'} className="space-y-3 border-t pt-3">
      <Field label="Entity name">{(id) => <CommitInput id={id} data-pointer={pointer + '/name'} value={name} commit={(next) => {
        void save({ op: 'renameEntity', entity: name, name: next }, 'rename entity ' + name).then((ok) => { if (ok) onSelect(next) })
      }} />}</Field>
      {findingsFor('/name')}
      <Field label="Plural route segment">{(id) => <CommitInput id={id} data-pointer={pointer + '/plural'} value={entity.plural} commit={(plural) => {
        void save({ op: 'setEntity', entity: { name, plural } }, 'set plural of ' + name)
      }} />}</Field>
      {findingsFor('/plural')}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Key name">{(id) => <CommitInput id={id} data-pointer={pointer + '/key/name'} value={entity.key.name} commit={(key) => {
          void save({ op: 'setEntity', entity: { name, key: { ...entity.key, name: key } } }, 'rename key on ' + name)
        }} />}</Field>
        <Field label="Key type">{(id) => (
          <select id={id} className={selectClass} data-pointer={pointer + '/key/type'} value={entity.key.type} onChange={(event) => {
            const type = event.target.value as ModelEntity['key']['type']
            void save({ op: 'setEntity', entity: { name, key: { name: entity.key.name, type } } }, 'set key type on ' + name)
          }}>
            <option value="uuid">uuid</option><option value="int">int</option><option value="long">long</option>
          </select>
        )}</Field>
      </div>
      {findingsFor('/key')}
      <section aria-label="Fields" className="space-y-2">
        <h3 className="text-xs font-semibold">Fields</h3>
        {entity.fields.map((field, index) => (
          <FieldRow key={field.name} field={field} pointer={pointer + '/fields/' + index} enums={enums}
            onSave={(next) => void saveField(next)}
            onRename={(next) => void save({ op: 'renameField', entity: name, field: field.name, name: next }, `rename ${field.name} on ${name}`)}
            onRemove={() => void save({ op: 'removeField', entity: name, field: field.name }, `remove ${field.name} from ${name}`)}
          >{findingsFor('/fields/' + index)}</FieldRow>
        ))}
        <form aria-label="Add field" className="grid gap-2" onSubmit={(event) => {
          event.preventDefault()
          const form = event.currentTarget
          const values = new FormData(form)
          const fieldName = formText(values, 'fieldName')
          if (duplicate(form, 'fieldName', fieldName, entity.fields)) return
          const field = newField(fieldName, formText(values, 'fieldType') as ModelField['type'], enums[0])
          if (field) void saveField(field).then((ok) => { if (ok) form.reset() })
        }}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="New field name">{(id) => (
              <Input id={id} name="fieldName" onInput={clearValidity} data-pointer={pointer + '/fields/' + entity.fields.length + '/name'} pattern={MEMBER} required />
            )}</Field>
            <Field label="New field type">{(id) => <TypeSelect id={id} name="fieldType" enums={enums} />}</Field>
          </div>
          {findingsFor('/fields/' + entity.fields.length)}
          <Button type="submit" size="xs" variant="outline">Add field</Button>
        </form>
      </section>
      <section aria-label="Relations" className="space-y-2 border-t pt-3">
        <h3 className="text-xs font-semibold">Relations</h3>
        {entity.relations.map((relation, index) => (
          <RelationRow
            key={relation.name} relation={relation} pointer={pointer + '/relations/' + index} targets={targets}
            save={(next) => void saveRelation(next)}
            remove={() => void save({ op: 'removeRelation', entity: name, relation: relation.name }, `remove ${relation.name} from ${name}`)}
          >{findingsFor('/relations/' + index)}</RelationRow>
        ))}
        <form aria-label="Add relation" className="grid gap-2" onSubmit={(event) => {
          event.preventDefault()
          const form = event.currentTarget
          const values = new FormData(form)
          const relationName = formText(values, 'relationName')
          if (duplicate(form, 'relationName', relationName, entity.relations)) return
          void saveRelation({
            name: relationName, kind: formText(values, 'relationKind') as ModelRelation['kind'],
            to: formText(values, 'relationTarget'), foreignKey: formText(values, 'relationKey'),
          }).then((ok) => { if (ok) form.reset() })
        }}>
          <Field label="New relation name">{(id) => <Input id={id} name="relationName" onInput={clearValidity} required pattern={MEMBER} />}</Field>
          <Field label="New relation kind">{(id) => <RelationKind id={id} name="relationKind" />}</Field>
          <Field label="New relation target">{(id) => <EntitySelect id={id} name="relationTarget" targets={targets} />}</Field>
          <Field label="New foreign key">{(id) => <Input id={id} name="relationKey" required pattern={MEMBER} />}</Field>
          {findingsFor('/relations/' + entity.relations.length)}
          <Button type="submit" size="xs" variant="outline">Add relation</Button>
        </form>
      </section>
      <ApiOptions entity={entity} pointer={pointer + '/api'} save={(api) => void save({ op: 'setEntityApi', entity: name, api }, 'set API options on ' + name)} />
      {findingsFor('/api')}
      {findingsFor('/indexes')}
      <Button type="button" size="xs" variant="destructive" onClick={() => void save({ op: 'removeEntity', entity: name }, 'remove entity ' + name)}>Remove entity</Button>
    </section>
  )
}

function newField(name: string, type: ModelField['type'], enumName?: string): ModelField | null {
  if (type === 'enum') return enumName ? { name, type, enum: enumName } : null
  if (type === 'decimal') return { name, type, precision: 18, scale: 2 }
  return { name, type }
}

function TypeSelect({ id, name, type, enums, onChange, pointer }: {
  id: string; name?: string; type?: ModelField['type']; enums: string[]; pointer?: string; onChange?(type: ModelField['type']): void
}) {
  return (
    <select id={id} name={name} data-pointer={pointer} className={selectClass} value={type} defaultValue={type === undefined ? 'string' : undefined}
      onChange={(event) => onChange?.(event.target.value as ModelField['type'])}>
      {MODEL_FIELD_TYPES.map((item) => <option key={item} disabled={item === 'enum' && !enums.length}>{item}</option>)}
    </select>
  )
}

function FieldRow({ field, pointer, enums, onSave, onRename, onRemove, children }: {
  field: ModelField; pointer: string; enums: string[]
  onSave(field: ModelField): void; onRename(name: string): void; onRemove(): void
  children: React.ReactNode
}) {
  const { name, type, required, default: defaultValue, renamedFrom, ...settings } = field
  return (
    <fieldset aria-label={'Field ' + name} className="min-w-0 space-y-2 rounded-md border p-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name">{(id) => <CommitInput id={id} value={name} data-pointer={pointer + '/name'} commit={onRename} />}</Field>
        <Field label="Type">{(id) => <TypeSelect id={id} type={type} enums={enums} pointer={pointer + '/type'} onChange={(next) => {
          const replacement = newField(name, next, enums[0])
          if (replacement) onSave({ ...replacement, required, renamedFrom, default: defaultValue, unique: field.unique, readOnly: field.readOnly, description: field.description })
        }} />}</Field>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={required ?? false} data-pointer={pointer + '/required'} onChange={(event) => onSave({ ...field, required: event.target.checked })} />
        Required
      </label>
      {children}
      <details className="space-y-2 text-xs">
        <summary className="cursor-pointer">Constraints and default</summary>
        <JsonField label="Constraints (JSON)" pointer={pointer} value={settings} object save={(value) => {
          onSave({ ...(value as object), name, type, required, renamedFrom, default: defaultValue } as ModelField)
        }} />
        <JsonField label="Default (JSON)" pointer={pointer + '/default'} value={defaultValue} save={(value) => onSave({ ...field, default: value })} />
        {defaultValue !== undefined && <Button type="button" size="xs" variant="ghost" onClick={() => onSave({ ...field, default: undefined })}>Clear default</Button>}
      </details>
      <Button type="button" size="xs" variant="ghost" onClick={onRemove}>Remove field</Button>
    </fieldset>
  )
}

function RelationKind({ id, name, value, pointer, change }: {
  id: string; name?: string; value?: ModelRelation['kind']; pointer?: string; change?(kind: ModelRelation['kind']): void
}) {
  return (
    <select id={id} name={name} data-pointer={pointer} value={value} className={selectClass} onChange={(event) => change?.(event.target.value as ModelRelation['kind'])}>
      <option value="belongsTo">belongsTo</option><option value="hasMany">hasMany</option>
    </select>
  )
}

function EntitySelect({ id, targets, name, value, pointer, change }: {
  id: string; targets: string[]; name?: string; value?: string; pointer?: string; change?(value: string): void
}) {
  return (
    <select id={id} name={name} data-pointer={pointer} className={selectClass} value={value} onChange={(event) => change?.(event.target.value)}>
      {[...new Set(value ? [value, ...targets] : targets)].map((target) => <option key={target}>{target}</option>)}
    </select>
  )
}

function RelationRow({ relation, pointer, targets, save, remove, children }: {
  relation: ModelRelation; pointer: string; targets: string[]
  save(relation: ModelRelation): void; remove(): void; children: React.ReactNode
}) {
  return (
    <fieldset className="min-w-0 space-y-2 rounded-md border p-2">
      <legend className="text-xs font-medium">{relation.name}</legend>
      <Field label="Kind">{(id) => <RelationKind id={id} value={relation.kind} pointer={pointer + '/kind'} change={(kind) => {
        save({ name: relation.name, to: relation.to, foreignKey: relation.foreignKey, kind })
      }} />}</Field>
      <Field label="Target">{(id) => <EntitySelect id={id} targets={targets} value={relation.to} pointer={pointer + '/to'} change={(to) => save({ ...relation, to })} />}</Field>
      <Field label="Foreign key">{(id) => (
        <CommitInput id={id} data-pointer={pointer + '/foreignKey'} value={relation.foreignKey} commit={(foreignKey) => save({ ...relation, foreignKey })} />
      )}</Field>
      {relation.kind === 'belongsTo' && (
        <>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={relation.required ?? false} data-pointer={pointer + '/required'} onChange={(event) => save({ ...relation, required: event.target.checked })} />
            Required relation
          </label>
          <Field label="On delete">{(id) => (
            <select id={id} data-pointer={pointer + '/onDelete'} value={relation.onDelete ?? ''} className={selectClass}
              onChange={(event) => save({ ...relation, onDelete: (event.target.value || undefined) as typeof relation.onDelete })}>
              <option value="">Default</option><option value="restrict">Restrict</option>
              <option value="cascade">Cascade</option><option value="setNull">Set null</option>
            </select>
          )}</Field>
        </>
      )}
      {children}
      <Button type="button" size="xs" variant="ghost" onClick={remove}>Remove relation</Button>
    </fieldset>
  )
}

function ApiOptions({ entity, pointer, save }: { entity: ModelEntity; pointer: string; save(api: ModelApi): void }) {
  const { api } = entity
  const fields = [...new Set([entity.key.name, ...entity.fields.map(({ name }) => name),
    ...entity.relations.filter(({ kind }) => kind === 'belongsTo').map(({ foreignKey }) => foreignKey)])]
  const toggle = <T extends string>(values: T[], value: T, checked: boolean) =>
    checked ? [...values, value] : values.filter((item) => item !== value)
  return (
    <details className="space-y-2 border-t pt-2 text-xs">
      <summary className="cursor-pointer font-medium">API options</summary>
      <fieldset className="space-y-1">
        <legend>Operations</legend>
        {API_OPERATIONS.map((operation) => (
          <label key={operation} className="flex items-center gap-2">
            <input type="checkbox" checked={api.operations.includes(operation)} onChange={(event) => {
              save({ ...api, operations: toggle(api.operations, operation, event.target.checked) })
            }} />
            {operation}
          </label>
        ))}
      </fieldset>
      {(['filterable', 'sortable', 'searchable'] as const).map((option) => {
        const values = api[option] ?? []
        return (
          <fieldset key={option} className="space-y-1">
            <legend className="capitalize">{option}</legend>
            {[...new Set([...fields, ...values])].map((field) => (
              <label key={field} className="flex items-center gap-2 [overflow-wrap:anywhere]">
                <input type="checkbox" checked={values.includes(field)} data-pointer={pointer + '/' + option + '/' + values.indexOf(field)}
                  onChange={(event) => save({ ...api, [option]: toggle(values, field, event.target.checked) })} />
                {field}
              </label>
            ))}
          </fieldset>
        )
      })}
      <JsonField label="Custom operations (JSON)" pointer={pointer + '/custom'} value={api.custom ?? []} array
        save={(value) => save({ ...api, custom: value as ModelApi['custom'] })} />
    </details>
  )
}
