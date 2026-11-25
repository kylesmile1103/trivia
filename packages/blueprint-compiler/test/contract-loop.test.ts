import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { modelSchema } from '@trivia/blueprint'
import { syncContract } from '@trivia/contract-sync'
import { afterEach, beforeEach, expect, it } from 'vitest'

const workspace = path.resolve(import.meta.dirname, '../../..')
const bank = path.join(workspace, 'packages/blueprint/fixtures/model/valid/bank/model.blueprint.json')
const snapshot = path.join(workspace, 'dotnet/tests/Trivia.Blueprint.Codegen.Tests/Snapshots/BankOpenApi.verified.txt')
const input = 'openapi/api.openapi.json'
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-contract-loop-'))
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

it('FR-AS-05 syncs the bank OpenAPI snapshot without overrides', async () => {
  fs.mkdirSync(path.join(root, 'openapi'))
  fs.copyFileSync(snapshot, path.join(root, input))

  const model = modelSchema.parse(JSON.parse(fs.readFileSync(bank, 'utf8')))
  const { manifest, files } = await syncContract({ cwd: root, input, zod: true })
  expect(manifest.source).toMatchObject({ location: input, excludedOperations: [] })
  expect(files).toEqual(expect.arrayContaining(['sdk.gen.ts', 'types.gen.ts', 'zod.gen.ts']))
  expect(manifest.resources.map(({ name }) => name)).toEqual(model.entities.map(({ name }) => name).sort())

  for (const entity of model.entities) {
    const resource = manifest.resources.find(({ name }) => name === entity.name)!
    expect(resource).toMatchObject({ groupedBy: 'tag', basePath: '/api/v1/' + entity.plural })
    expect(Object.keys(resource.operations)).toEqual(['list', 'get', 'create', 'update', 'delete'])
    expect(Object.entries(resource.operations).filter(([, operation]) => operation !== null).map(([kind]) => kind))
      .toEqual(entity.api.operations)
    expect(resource.operations.list).toMatchObject({
      listItemsPath: 'items',
      pagination: { style: 'page', pageParam: 'page', pageSizeParam: 'pageSize', totalPath: 'total' },
    })
  }
  expect(manifest.resources.find(({ name }) => name === 'Customer')?.customOperations.map(({ operationId }) => operationId))
    .toEqual(['approveKycCustomer'])
})
