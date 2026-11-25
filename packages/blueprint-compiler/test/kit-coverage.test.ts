import { readFileSync } from 'node:fs'

import { appSchema, loadBlueprint } from '@trivia/blueprint'
import { expect, it } from 'vitest'

import { fixture, kitManifests, missingKitTypes } from './kit-fixture.js'

it('SC-001 covers every published kit manifest with a fixture page', () => {
  expect(appSchema.safeParse(loadBlueprint(fixture()).docs['app.blueprint.json']?.doc).success).toBe(true)
  expect(missingKitTypes(kitManifests(), fixture())).toEqual([])
})

it('SC-001 reports a manifest type missing from the fixture', () => {
  expect(missingKitTypes([{ type: 'MissingExample' }], fixture())).toEqual(['MissingExample'])
})

it('FR-KT-01 and FR-KT-07 document the published and deferred manifest inventory', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
  const design = read('../../../docs/blueprint/lld/LLD-06-component-kit.md')
  const inventory = /^## 2\. Published manifests[^\n]*\n([\s\S]*?)^## 3\./m.exec(design)?.[1] ?? ''
  const limits = /^## 5\. Deferred[^\n]*\n([\s\S]*?)^## 6\./m.exec(design)?.[1] ?? ''
  const listed = (section: string, name: string) => section.includes('`' + name + '`')
  const kit = kitManifests()
  expect(kit.filter(({ composite }) => !composite)).toHaveLength(25)
  expect(kit.filter(({ type }) => !listed(inventory, type)).map(({ type }) => type)).toEqual([])
  const deferred = Object.keys(JSON.parse(read('../kit/deferred.json')))
  expect(deferred.filter((type) => !listed(limits, type))).toEqual([])
})

it('FR-KT-02 demonstrates both selection exposures in the fixture blueprint', () => {
  const documents = Object.values(fixture())
  expect(documents.some((text) => text.includes('ui.customers.selectedRow.id'))).toBe(true)
  expect(documents.some((text) => text.includes('ui.customers.selectedRows.length'))).toBe(true)
})
