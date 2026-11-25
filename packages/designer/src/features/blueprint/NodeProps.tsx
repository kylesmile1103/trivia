import { useState } from 'react'

import { EnumSetter } from '@/shared/components/EnumSetter'
import type {
  ActionStep, BlueprintComponents, BlueprintDiagnostic, BlueprintDocument, BlueprintOp, BlueprintPatchResult,
  BlueprintPropSchema, CustomPage, JsonValue,
} from '@/shared/engine/types'
import { Button } from '@/shared/ui/button'

import { ExpressionInput } from './ExpressionInput'
import { CommitInput, Field, JsonField, selectClass } from './fields'

interface NodePropsProps {
  document: BlueprintDocument<CustomPage>
  catalog: BlueprintComponents
  nodeId: string
  diagnostics: BlueprintDiagnostic[]
  busy?: boolean
  commit(ops: BlueprintOp[], label: string): Promise<BlueprintPatchResult | null>
}

export function NodeProps({ document: { doc, path, rev }, catalog, nodeId, diagnostics, busy, commit }: NodePropsProps) {
  const node = doc.nodes[nodeId]
  if (!node) return null
  const nodeName = node.name
  const component = catalog.components.find(({ type }) => type === node.type)
  const schema = catalog.schemas[node.type]?.properties ?? {}
  const staticProps = doc.props[nodeId] ?? {}
  const bindings = doc.bindings[nodeId] ?? {}
  const style = doc.styles[nodeId]
  const names = [...new Set([...Object.keys(schema), ...Object.keys(staticProps), ...Object.keys(bindings), ...(style ? ['className'] : [])])]
  const guard = { doc: path, baseRev: rev, node: nodeId, expectedType: node.type }

  function setStatic(prop: string, value: JsonValue) {
    const ops: BlueprintOp[] = []
    if (prop === 'className' && style && (typeof value === 'string' || value === null)) {
      ops.push({ op: 'setStyle', ...guard, className: value })
      if (bindings[prop] !== undefined) ops.push({ op: 'setBinding', ...guard, prop, expr: null })
      if (value === null && Object.hasOwn(staticProps, prop)) ops.push({ op: 'setProp', ...guard, prop, value: null })
    } else {
      if (value === null && bindings[prop] !== undefined) ops.push({ op: 'setBinding', ...guard, prop, expr: null })
      if (value !== null || Object.hasOwn(staticProps, prop)) ops.push({ op: 'setProp', ...guard, prop, value })
    }
    if (ops.length) void commit(ops, `Blueprint: set ${nodeName}.${prop}`)
  }

  return (
    <fieldset aria-label="Node properties" disabled={busy} className="space-y-3 border-t pt-2">
      <legend className="text-xs font-semibold">Node properties</legend>
      <Field label="Node name">{(id) => (
        <CommitInput id={id} data-pointer={`/nodes/${nodeId}/name`} value={node.name} commit={(name) => {
          void commit([{ op: 'renameNode', ...guard, name: name.trim() }], `Blueprint: rename ${node.name}`)
        }} />
      )}</Field>
      {component?.exposes.length ? (
        <div className="space-y-1 text-xs">
          <h4 className="font-medium">Exposed values</h4>
          <ul className="space-y-0.5 [overflow-wrap:anywhere]">{component.exposes.map(({ name, type }) => (
            <li key={name}><code>ui.{node.name}.{name}</code> <span className="text-muted-foreground">· {type}</span></li>
          ))}</ul>
        </div>
      ) : null}
      {names.map((name) => {
        const pointer = `/bindings/${nodeId}/${name}`
        return (
          <BlueprintProp
            key={name} name={name} schema={schema[name] ?? {}} staticPointer={`/props/${nodeId}/${name}`} bindingPointer={pointer}
            value={name === 'className' ? style?.className ?? staticProps[name] : staticProps[name]} binding={bindings[name]}
            diagnostics={diagnostics.filter((item) => item.doc === path && item.pointer === pointer)}
            onStatic={(value) => setStatic(name, value)}
            onBinding={(expr) => { void commit([{ op: 'setBinding', ...guard, prop: name, expr }], `Blueprint: bind ${node.name}.${name}`) }}
          />
        )
      })}
      {!!component?.events.length && (
        <details className="space-y-2 text-xs">
          <summary className="cursor-pointer">Events</summary>
          {component.events.map(({ name, payload }) => {
            const key = nodeId + '.' + name
            return (
              <div key={name} className="space-y-1">
                {payload && <p className="text-muted-foreground [overflow-wrap:anywhere]">{payload}</p>}
                <JsonField label={name + ' steps (JSON)'} pointer={'/actions/' + key} value={doc.actions[key] ?? []} array save={(value) => {
                  void commit([{ op: 'setActions', ...guard, event: name, steps: value as ActionStep[] }], `Blueprint: set ${node.name}.${name}`)
                }} />
              </div>
            )
          })}
        </details>
      )}
    </fieldset>
  )
}

type Mode = 'static' | 'binding'
function BlueprintProp({ name, value, binding, schema, staticPointer, bindingPointer, diagnostics, onStatic, onBinding }: {
  name: string
  value: JsonValue | undefined
  binding: string | undefined
  schema: BlueprintPropSchema
  staticPointer: string
  bindingPointer: string
  diagnostics: BlueprintDiagnostic[]
  onStatic(value: JsonValue): void
  onBinding(expr: string): void
}) {
  const [choice, setChoice] = useState<{ basis: string; mode: Mode } | null>(null)
  const persisted = binding === undefined ? 'static' : 'binding'
  const basis = JSON.stringify([value, binding])
  const mode = choice?.basis === basis ? choice.mode : persisted
  return (
    <div className="grid gap-1.5 rounded-md border p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium [overflow-wrap:anywhere]">{name}</span>
        <select
          aria-label={name + ' mode'} value={mode} className={selectClass + ' h-6 w-auto text-xs'}
          onChange={(event) => setChoice({ basis, mode: event.target.value as Mode })}
        >
          <option value="static">Static</option>
          <option value="binding">Binding</option>
        </select>
      </div>
      {schema.description && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{schema.description}</p>}
      {mode === 'binding' ? (
        <ExpressionInput
          label={name + ' expression'} pointer={bindingPointer} value={binding ?? JSON.stringify(value ?? schema.default ?? '')}
          proposed={binding === undefined} diagnostics={diagnostics} onSave={onBinding}
        />
      ) : <StaticProp {...{ name, value, schema, pointer: staticPointer, onStatic }} />}
      {(value !== undefined || binding !== undefined) && (
        <Button type="button" size="xs" variant="ghost" className="justify-self-start" onClick={() => onStatic(null)}>Reset {name}</Button>
      )}
    </div>
  )
}

function StaticProp({ name, value, schema, pointer, onStatic }: {
  name: string
  value: JsonValue | undefined
  schema: BlueprintPropSchema
  pointer: string
  onStatic(value: JsonValue): void
}) {
  const placeholder = schema.default === undefined ? 'Unset' : String(schema.default)
  const options = schema.enum
  // Radix reserves the empty option value for its placeholder.
  if (options?.includes('')) return (
    <Field label={name}>{(id) => (
      <select id={id} className={selectClass} data-pointer={pointer}
        value={typeof value === 'string' && options.includes(value) ? String(options.indexOf(value)) : ''}
        onChange={(event) => { const next = options[Number(event.target.value)]; if (next !== undefined) onStatic(next) }}>
        <option value="" disabled>{placeholder}</option>
        {options.map((option, index) => <option key={index} value={index}>{option === '' ? '(empty string)' : option}</option>)}
      </select>
    )}</Field>
  )
  if (options) return (
    <Field label={name}>{(id) => <EnumSetter id={id} pointer={pointer} value={typeof value === 'string' ? value : undefined}
      options={options} placeholder={placeholder} onCommit={onStatic} />}</Field>
  )
  if (schema.type === 'boolean') return (
    <Field label={name}>{(id) => (
      <select id={id} data-pointer={pointer} className={selectClass} value={typeof value === 'boolean' ? String(value) : ''}
        onChange={(event) => onStatic(event.target.value === 'true')}>
        <option value="" disabled>{placeholder}</option>
        <option value="true">True</option><option value="false">False</option>
      </select>
    )}</Field>
  )
  if (schema.type === 'string' || schema.type === 'number') return (
    <Field label={name}>{(id) => (
      <CommitInput
        id={id} data-pointer={pointer} value={typeof value === schema.type ? String(value) : ''}
        type={schema.type === 'string' ? 'text' : 'number'} step={schema.type === 'number' ? 'any' : undefined}
        placeholder={placeholder} commit={(text) => onStatic(schema.type === 'number' ? (text === '' ? null : Number(text)) : text)}
      />
    )}</Field>
  )
  return <JsonField label={name + ' (JSON)'} pointer={pointer} value={value ?? null} save={onStatic} />
}
