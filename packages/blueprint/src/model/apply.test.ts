import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture, renderWrites } from '../../test/helpers.js'
import { Draft, Refusal } from '../apply/draft.js'
import { sequenceSource } from '../ids.js'
import { rev, revOfText, serialize } from '../serialize.js'
import { loadBlueprint } from '../store.js'
import { MODEL_DOC } from '../types/ops.js'
import { applyModelOp, modelOpSchema } from './apply.js'
import { modelSchema } from './types.js'
import { validateModel } from './validate.js'

const fixtures = `${FIXTURES}/model`
const bank = readFixture(`${fixtures}/valid/bank`)[MODEL_DOC]!

function run(ops: readonly object[], before: string | null = bank) {
  const draft = new Draft(loadBlueprint(before === null ? {} : { [MODEL_DOC]: before }), { ids: sequenceSource() })
  const baseRev = before === null ? null : revOfText(before)
  for (const op of ops) applyModelOp(draft, modelOpSchema.parse({ doc: MODEL_DOC, baseRev, ...op }))
  return draft.changes().map(([file, doc]) => ({ file, before, after: doc === null ? null : serialize(doc) }))
}

describe('FR-DM-07, FR-DM-08: model operation diffs', () => {
  it.each(['create', 'rename-and-edit', 'remove'])('applies the %s fixture in declared order', (name) => {
    const dir = `${fixtures}/ops/${name}`
    const ops = JSON.parse(fs.readFileSync(`${dir}/ops.json`, 'utf8'))
    const writes = run(ops, name === 'create' ? null : bank)
    expect(renderWrites(writes)).toBe(fs.readFileSync(`${dir}/expected.diff`, 'utf8'))
    const model = modelSchema.parse(JSON.parse(writes[0]!.after!))
    expect(validateModel(model, rev(model))).toEqual([])
  })

  it('applies the guarded diagnostic fix, including the supplied base revision', () => {
    const before = readFixture(`${fixtures}/invalid/unmatched_relation`)[MODEL_DOC]!
    const model = modelSchema.parse(JSON.parse(before))
    const [finding] = validateModel(model, revOfText(before))
    expect(finding?.hint?.ops?.[0]?.baseRev).toBe(revOfText(before))
    const writes = run(finding!.hint!.ops!, before)
    const repaired = modelSchema.parse(JSON.parse(writes[0]!.after!))
    expect(validateModel(repaired, rev(repaired))).toEqual([])
  })

  it('names inbound relations when refusing to remove their entity', () => {
    expect(() => run([{ op: 'removeEntity', entity: 'Customer' }])).toThrow(Refusal)
    expect(() => run([{ op: 'removeEntity', entity: 'Customer' }])).toThrow(/Account\.customer.*Transaction\.reviewer/)
  })

  it('refuses to remove an enum used by a field', () => {
    expect(() => run([{ op: 'removeEnum', name: 'CustomerStatus' }])).toThrow(/Customer\.status/)
  })

  it('retains the first migration name over repeated renames and clears it when renamed back', () => {
    const [write] = run([
      { op: 'renameField', entity: 'Customer', field: 'fullName', name: 'legalName' },
      { op: 'renameField', entity: 'Customer', field: 'legalName', name: 'displayName' },
      { op: 'setField', entity: 'Customer', field: { name: 'displayName', type: 'string', required: true } },
      { op: 'renameEntity', entity: 'Customer', name: 'Client' },
      { op: 'renameEntity', entity: 'Client', name: 'Customer' },
    ])
    const [customer] = modelSchema.parse(JSON.parse(write!.after!)).entities
    expect(customer?.fields[0]).toMatchObject({ name: 'displayName', renamedFrom: 'fullName', required: true })
    expect(customer?.api.sortable).toEqual(['displayName', 'createdAt'])
    expect(customer?.api.searchable).toEqual(['displayName', 'email'])
    expect(customer?.renamedFrom).toBeUndefined()
  })

  it('refuses moves past the final field index and ambiguous renames', () => {
    expect(() => run([{ op: 'moveField', entity: 'Account', field: 'frozen', index: 4 }]))
      .toThrow(/past the end of Account.fields/)
    expect(() => run([{ op: 'renameField', entity: 'Account', field: 'frozen', name: 'accountnumber' }]))
      .toThrow(/already in use/)
  })
})
