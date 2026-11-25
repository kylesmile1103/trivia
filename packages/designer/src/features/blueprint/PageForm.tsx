import { useState } from 'react'

import { CONTRACT_KINDS, pageDocPath } from '@/shared/engine/blueprint-types'
import type {
  BlueprintDocument, BlueprintOp, BlueprintPage, BlueprintPageKind, ContractAction, ContractKind, ContractOptions, ManifestResource,
} from '@/shared/engine/types'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

import { CommitInput, Field, JsonField, selectClass } from './fields'

export type SaveBlueprintOp = (op: BlueprintOp, label: string) => Promise<boolean>
type Meta = Omit<Extract<BlueprintOp, { op: 'setPageMeta' }>, 'doc' | 'baseRev' | 'op'>

interface PageFormProps {
  document?: BlueprintDocument<BlueprintPage>
  resources: ManifestResource[]
  busy?: boolean
  save: SaveBlueprintOp
}

const operations = { list: 'list', show: 'get', create: 'create', edit: 'update' } as const
const kinds = [...CONTRACT_KINDS, 'custom'] as const

function resourceFields(resource: ManifestResource | undefined, kind: ContractKind): string[] {
  const operation = operations[kind]
  const isForm = operation === 'create' || operation === 'update'
  const fields = isForm ? resource?.operations[operation]?.requestBody?.fields?.filter((field) => !field.readOnly) : resource?.entity?.fields
  return fields?.map(({ name }) => name) ?? []
}

function compatibleOptions(options: ContractOptions, fields: string[]): ContractOptions {
  const next = { ...options }
  for (const key of ['fields', 'hideFields', 'filters'] as const) {
    if (next[key]) next[key] = next[key].filter((field) => fields.includes(field))
  }
  return next
}

export function PageForm({ document, resources, busy = false, save }: PageFormProps) {
  if (document) return <EditPage document={document} resources={resources} busy={busy} save={save} />
  return <CreatePage resources={resources} busy={busy} save={save} />
}

function CreatePage({ resources, busy, save }: Omit<PageFormProps, 'document'>) {
  const [kind, setKind] = useState<BlueprintPageKind>('custom')
  const [resource, setResource] = useState('')
  const choices = kind === 'custom' ? [] : resources.filter((candidate) => candidate.operations[operations[kind]])
  const selected = choices.some((candidate) => candidate.name === resource) ? resource : (choices[0]?.name ?? '')

  return (
    <form onSubmit={(event) => {
      event.preventDefault()
      const fields = new FormData(event.currentTarget)
      const name = String(fields.get('name') ?? '').trim()
      const route = String(fields.get('route') ?? '').trim()
      void save({
        op: 'createPage', doc: pageDocPath(name), baseRev: null, name, route, kind, ...(selected && { resource: selected }),
      }, `Blueprint: create ${name}`)
    }}>
      <fieldset disabled={busy} className="grid gap-3">
        <Field label="Name">{(id) => <Input id={id} name="name" data-pointer="/name" required pattern="[A-Z][A-Za-z0-9]*" placeholder="CustomerList" />}</Field>
        <Field label="Route">{(id) => <Input id={id} name="route" data-pointer="/route" required placeholder="/customers" />}</Field>
        <Field label="Kind">{(id) => (
          <select id={id} name="kind" data-pointer="/kind" className={selectClass} value={kind} onChange={(event) => setKind(event.target.value as BlueprintPageKind)}>
            {kinds.map((item) => (
              <option key={item} value={item} disabled={item !== 'custom' && !resources.some((candidate) => candidate.operations[operations[item]])}>{item}</option>
            ))}
          </select>
        )}</Field>
        {resources.length === 0 && <p className="text-xs text-muted-foreground">Sync an API contract in the Data tab to add a contract page.</p>}
        {kind !== 'custom' && (
          <Field label="Resource">{(id) => (
            <select id={id} name="resource" data-pointer="/resource" required className={selectClass} value={selected} onChange={(event) => setResource(event.target.value)}>
              {!selected && <option value="">Select a resource</option>}
              {choices.map(({ name }) => <option key={name}>{name}</option>)}
            </select>
          )}</Field>
        )}
        <Button type="submit" size="sm" disabled={kind !== 'custom' && !selected}>Create page</Button>
      </fieldset>
    </form>
  )
}

function EditPage({ document: { doc, path, rev }, resources, busy, save }: PageFormProps & {
  document: BlueprintDocument<BlueprintPage>
}) {
  const update = (key: string, change: Meta) => void save(
    { op: 'setPageMeta', doc: path, baseRev: rev, ...change }, `Blueprint: set ${key} of ${doc.name}`,
  )

  return (
    <fieldset disabled={busy} className="grid gap-3">
      <Field label="Name">{(id) => <CommitInput id={id} data-pointer="/name" value={doc.name} commit={(name) => update('name', { name: name.trim() })} />}</Field>
      <Field label="Route">{(id) => <CommitInput id={id} data-pointer="/route" value={doc.route} commit={(route) => update('route', { route: route.trim() })} />}</Field>
      {doc.kind === 'custom'
        ? <p className="text-xs text-muted-foreground">Kind: custom</p>
        : <ContractFields doc={doc} resources={resources} update={update} />}
    </fieldset>
  )
}

function ContractFields({ doc, resources, update }: {
  doc: Extract<BlueprintPage, { options: ContractOptions }>
  resources: ManifestResource[]
  update(key: string, change: Meta): void
}) {
  const { kind, options, resource } = doc
  const current = resources.find((candidate) => candidate.name === resource)
  const fields = resourceFields(current, kind)
  const choices = resources.filter((candidate) => candidate.operations[operations[kind]])
  const anyRowActions = (options.rowActions?.length ?? 0) > 0
  function option<K extends keyof ContractOptions>(key: K, value: ContractOptions[K]) {
    const next = { ...options }
    if (value === undefined) delete next[key]
    else next[key] = value
    update(key, { options: next })
  }

  return (
    <>
      <Field label="Kind">{(id) => (
        <select id={id} name="kind" data-pointer="/kind" className={selectClass} value={kind} onChange={(event) => {
          const next = event.target.value as ContractKind
          update('kind', { kind: next, options: compatibleOptions(options, resourceFields(current, next)) })
        }}>
          {CONTRACT_KINDS.map((item) => (
            <option key={item} disabled={item !== kind && (!current?.operations[operations[item]] || anyRowActions)}>{item}</option>
          ))}
        </select>
      )}</Field>
      <Field label="Resource">{(id) => (
        <select id={id} data-pointer="/resource" className={selectClass} value={resource} onChange={(event) => {
          const next = event.target.value
          update('resource', { resource: next, options: compatibleOptions(options, resourceFields(choices.find(({ name }) => name === next), kind)) })
        }}>
          {!choices.some(({ name }) => name === resource) && <option>{resource}</option>}
          {choices.map(({ name }) => <option key={name}>{name}</option>)}
        </select>
      )}</Field>
      {!resources.length && <p className="text-xs text-muted-foreground">Sync an API contract in the Data tab to choose a resource.</p>}
      <Field label="Title">{(id) => (
        <CommitInput id={id} data-pointer="/options/title" value={options.title ?? ''} commit={(text) => option('title', text.trim() || undefined)} />
      )}</Field>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" aria-label="Use template fields" checked={options.fields === undefined} onChange={(event) => option('fields', event.target.checked ? undefined : [])} />
        Use template fields
      </label>
      <Checklist label="Fields" pointer="/options/fields" fields={fields} value={options.fields} disabled={options.fields === undefined} save={(value) => option('fields', value)} />
      <Checklist label="Hidden fields" pointer="/options/hideFields" fields={fields} value={options.hideFields} save={(value) => option('hideFields', value)} />
      {kind === 'list' && (
        <>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={options.filters === undefined} onChange={(event) => option('filters', event.target.checked ? undefined : [])} />
            Use template filters
          </label>
          <Checklist label="Filters" pointer="/options/filters" fields={fields} value={options.filters} disabled={options.filters === undefined} save={(value) => option('filters', value)} />
          <JsonField label="Row actions (JSON)" pointer="/options/rowActions" value={options.rowActions ?? []} array save={(value) => option('rowActions', value as ContractAction[])} />
        </>
      )}
      <JsonField label="Header actions (JSON)" pointer="/options/headerActions" value={options.headerActions ?? []} array save={(value) => option('headerActions', value as ContractAction[])} />
    </>
  )
}

function Checklist({ label, pointer, fields, value = [], disabled, save }: {
  label: string; pointer: string; fields: string[]; value?: string[]; disabled?: boolean; save(value: string[]): void
}) {
  return (
    <fieldset disabled={disabled} className="space-y-1">
      <legend className="mb-1 text-xs font-medium">{label}</legend>
      {[...new Set([...fields, ...value])].map((name) => (
        <label key={name} className="flex items-center gap-2 break-all text-xs">
          <input
            type="checkbox" data-pointer={pointer + (value.includes(name) ? '/' + value.indexOf(name) : '')}
            checked={value.includes(name)} onChange={(event) => save(event.target.checked ? [...value, name] : value.filter((field) => field !== name))}
          />
          {name}
        </label>
      ))}
    </fieldset>
  )
}
