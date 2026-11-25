import fs from 'node:fs'

import { loadBlueprint, pageDocPath, type ComponentManifest } from '@trivia/blueprint'
import * as engine from '@trivia/engine'
import { expect, it } from 'vitest'

import { compilePage, projectFacts, type CompileContext } from '../src/index.js'

const kit = ['Button', 'Card', 'Input'].map((type) => JSON.parse(fs.readFileSync(new URL(
  '../../blueprint/fixtures/manifests/kit-sample/' + type + '.manifest.json', import.meta.url,
), 'utf8')) as ComponentManifest)

const contract: NonNullable<CompileContext['contract']> = JSON.parse(fs.readFileSync(new URL(
  '../../../examples/refine-admin/trivia.manifest.json', import.meta.url,
), 'utf8'))
const account = contract.resources.find(({ name }) => name === 'Account')!
account.customOperations.push({
  ...account.operations.get!, kind: 'custom', operationId: 'getAccountStats', sdkFn: 'getAccountStats',
  path: '/api/v1/accounts/{id}/stats',
}, {
  ...account.operations.update!, kind: 'custom', operationId: 'closeAccount', sdkFn: 'closeAccount',
  method: 'POST', path: '/api/v1/accounts/{id}/close',
})
const context: CompileContext = {
  facts: projectFacts(),
  engine, contract,
  manifests: Object.fromEntries(kit.map((manifest) => [manifest.type, { ...manifest, installed: true }])),
}

function golden(fixture: string, name: string) {
  const dir = new URL('../fixtures/pages/' + fixture + '/', import.meta.url)
  const blueprint = loadBlueprint({ [pageDocPath(name)]: fs.readFileSync(new URL(name + '.page.json', dir), 'utf8') })
  const expected = fs.readFileSync(new URL(name + '.tsx', dir), 'utf8')
  const emitted = compilePage(blueprint, name, context)
  expect(emitted).toMatchObject({
    file: 'src/pages/' + name + '/' + name + '.tsx', code: expected, requires: [],
  })
  return emitted
}

it('FR-RC-01 and FR-RC-04: emits ordered static nodes and derives component imports', () => {
  golden('static', 'StaticPage')
})

it('FR-RC-03: lowers state and an exposed input to controlled props and text', () => {
  golden('state', 'SearchPanel')
})

it('FR-RC-03: binds list, one and custom query results and orders dependent hooks', () => {
  golden('queries', 'AccountQueries')
})

it('FR-RC-03: runs all action steps in order and produces one typed call handler stub', () => {
  expect(golden('actions', 'AccountActions').handler).toEqual({
    file: 'src/handlers/AccountActions.ts',
    code: fs.readFileSync(new URL('../fixtures/pages/actions/AccountActions.handler.ts', import.meta.url), 'utf8'),
  })
})

it('FR-RC-03: emits keyed repeats, scoped conditions and the component slot wrappers', () => {
  golden('control', 'AccountCard')
})
