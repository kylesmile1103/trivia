import { readFileSync } from 'node:fs'

import type { TriviaManifest } from '@trivia/contract-sync'
import { expect, it } from 'vitest'

import { columnFor } from '../src/refine/columns.js'
import { formFieldFor } from '../src/refine/fields.js'
import { generateRefineSnippets } from '../src/refine/scaffold.js'

it('shares exactly the column, controller, rule and default snippets used by the adapter (FR-KT-02, FR-KT-03)', () => {
  const manifest: TriviaManifest = JSON.parse(readFileSync(
    new URL('../../../examples/blueprint-kit/trivia.manifest.json', import.meta.url), 'utf8',
  ))
  const customer = manifest.resources.find(({ name }) => name === 'Customer')!
  const column = customer.entity!.fields.find(({ name }) => name === 'status')!
  const field = customer.operations.create!.requestBody!.fields!.find(({ name }) => name === 'fullName')!
  const project = { ui: '#/ui', refineUi: '#/refine-ui', textarea: true, style: 'form' as const }
  const snippets = generateRefineSnippets(project)
  expect(snippets.column(column, true)).toEqual(columnFor(column, {
    badge: '#/ui/badge', dataTable: '#/refine-ui/data-table', filter: true,
  }))
  expect(snippets.field(field, 'new-customer')).toEqual(formFieldFor(field, {
    ui: '#/ui', idPrefix: 'new-customer', textarea: true, style: 'form',
  }))
})

it('writes an enum option JSX cannot hold in an attribute string as an expression', () => {
  const field = { name: 'tier', type: 'string' as const, format: null, enum: ['plain', 'say "hi"', 'a\\b', 'x & y'], required: true, nullable: false }
  const { controller } = formFieldFor(field, { ui: '@/components/ui', idPrefix: 'customer' })
  expect(controller).toContain('<SelectItem value="plain">Plain</SelectItem>')
  expect(controller).toContain('<SelectItem value={"say \\"hi\\""}>')
  expect(controller).toContain('<SelectItem value={"a\\\\b"}>')
  expect(controller).toContain('<SelectItem value={"x & y"}>')
})
