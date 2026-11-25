// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'

import { MODEL_DOC } from '@/shared/engine/blueprint-types'
import type { BlueprintDiagnostic, BlueprintDocument, BlueprintModel, BlueprintOp } from '@/shared/engine/types'
import { find, mount, press, typeInto } from '@/shared/lib/test-utils'

import { ModelEditor } from './ModelEditor'

const model: BlueprintDocument<BlueprintModel> = {
  path: MODEL_DOC, rev: 'read', doc: {
    $schema: 'model', blueprintVersion: 1, namespace: 'Bank', enums: [],
    entities: [
      {
        name: 'Account', plural: 'accounts', key: { name: 'id', type: 'uuid' },
        fields: [{ name: 'displayName', type: 'string' }], relations: [], indexes: [], api: { operations: ['list'] },
      },
      {
        name: 'Customer', plural: 'customers', key: { name: 'id', type: 'uuid' },
        fields: [], relations: [], indexes: [], api: { operations: [] },
      },
    ],
  },
}

it('FR-DS-05 saves one guarded model op per cell and places reserved names beside the field', async () => {
  const commit = vi.fn().mockResolvedValue(null)
  const diagnostic: BlueprintDiagnostic = {
    code: 'reserved_name', severity: 'error', doc: MODEL_DOC, pointer: '/entities/0/fields/0/name', message: '"class" is reserved by C#',
  }
  const ui = await mount(<ModelEditor document={model} appName="Bank" diagnostics={[diagnostic]} commit={commit} />)
  try {
    const field = find(ui.host, 'fieldset[aria-label="Field displayName"]')
    expect(field.textContent).toContain(diagnostic.message)
    const name = find<HTMLInputElement>(field, '[data-pointer$="/name"]')
    await typeInto(name, 'class')
    await press(name, { key: 'Enter' })
    expect(commit).toHaveBeenCalledExactlyOnceWith([{
      op: 'renameField', doc: MODEL_DOC, baseRev: 'read', entity: 'Account', field: 'displayName', name: 'class',
    }], 'Blueprint: rename displayName on Account')
  } finally {
    await ui.unmount()
  }
})

it('FR-DS-05 can repair a refused hasMany in one batch with its suggested inverse', async () => {
  const commit = vi.fn().mockResolvedValue(null)
  const proposed: BlueprintOp = {
    doc: MODEL_DOC, baseRev: 'read', op: 'setRelation', entity: 'Account',
    relation: { name: 'customers', kind: 'hasMany', to: 'Customer', foreignKey: 'accountId' },
  }
  const inverse: BlueprintOp = {
    doc: MODEL_DOC, baseRev: 'candidate', op: 'setRelation', entity: 'Customer',
    relation: { name: 'account', kind: 'belongsTo', to: 'Account', foreignKey: 'accountId' },
  }
  const diagnostic: BlueprintDiagnostic = {
    code: 'unmatched_relation', severity: 'error', doc: MODEL_DOC, pointer: '/entities/0/relations/0/foreignKey',
    message: 'Customer needs a belongsTo relation', hint: { ops: [inverse] },
  }
  const ui = await mount(<ModelEditor
    document={model} appName="Bank" diagnostics={[]} rejected={{ ops: [proposed], diagnostics: [diagnostic] }} commit={commit}
  />)
  try {
    const fix = [...ui.host.querySelectorAll('button')].find((item) => item.textContent === 'Apply fix')
    expect(fix).toBeDefined()
    await act(async () => fix!.click())
    expect(commit).toHaveBeenCalledExactlyOnceWith([proposed, { ...inverse, baseRev: 'read' }], 'Blueprint: fix model diagnostic')
  } finally {
    await ui.unmount()
  }
})

it('FR-DS-05 keeps Add field from replacing an existing field', async () => {
  const commit = vi.fn().mockResolvedValue(null)
  const ui = await mount(<ModelEditor document={model} appName="Bank" diagnostics={[]} commit={commit} />)
  try {
    const form = find<HTMLFormElement>(ui.host, 'form[aria-label="Add field"]')
    const name = find<HTMLInputElement>(form, 'input[name="fieldName"]')
    await typeInto(name, 'displayName')
    await act(async () => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })))
    expect(commit).not.toHaveBeenCalled()
    expect(name.validationMessage).toContain('already in use')
  } finally {
    await ui.unmount()
  }
})
