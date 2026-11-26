import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { APP_DOC, appSchema, MODEL_DOC, modelSchema, pageSchema, SCHEMA_URL, serialize } from '@trivia/blueprint'
import { syncContract } from '@trivia/contract-sync'
import { refineName } from '../src/index.js'
import { afterEach, beforeEach, expect, it } from 'vitest'

const workspace = path.resolve(import.meta.dirname, '../../..')
const bank = path.join(workspace, 'packages/blueprint/fixtures/model/valid/bank/model.blueprint.json')
const snapshot = path.join(workspace, 'dotnet/tests/Trivia.Blueprint.Codegen.Tests/Snapshots/BankOpenApi.verified.txt')
const input = 'openapi/api.openapi.json'
let root: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-contract-loop-')))
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
  // The API serves PUT (full replace) and PATCH (merge) on the item path. Contract-sync keeps PUT
  // in the update slot, whose request describes the whole record an edit form edits, and lists
  // PATCH, which the data provider's update sends, as a custom operation.
  const customer = manifest.resources.find(({ name }) => name === 'Customer')!
  expect(customer.operations.update).toMatchObject({ method: 'PUT', path: '/api/v1/customers/{id}', operationId: 'updateCustomer' })
  expect(customer.customOperations.map(({ operationId, method, path }) => ({ operationId, method, path }))).toEqual([
    { operationId: 'patchCustomer', method: 'PATCH', path: '/api/v1/customers/{id}' },
    { operationId: 'approveKycCustomer', method: 'POST', path: '/api/v1/customers/{id}/approve-kyc' },
  ])
  expect(customer.customOperations[0]?.summary).toBe('Change some fields of the customer')
})


it('FR-AS-08 reports a fix on every ejected page that used a removed model field', async () => {
  const web = path.join(root, 'web')
  const blueprint = path.join(web, 'blueprint')
  const template = path.join(workspace, 'packages/blueprint-compiler/templates/vite-refine')
  fs.mkdirSync(path.join(web, 'openapi'), { recursive: true })
  fs.mkdirSync(path.join(blueprint, 'pages'), { recursive: true })
  fs.copyFileSync(snapshot, path.join(web, input))
  fs.copyFileSync(bank, path.join(blueprint, MODEL_DOC))
  fs.copyFileSync(path.join(template, 'components.json'), path.join(web, 'components.json'))
  fs.mkdirSync(path.join(web, 'src'))
  fs.copyFileSync(path.join(template, 'src/App.tsx'), path.join(web, 'src/App.tsx'))
  fs.cpSync(path.join(workspace, 'examples/refine-admin/src/components'), path.join(web, 'src/components'), { recursive: true })
  fs.writeFileSync(path.join(blueprint, APP_DOC), serialize(appSchema.parse({
    $schema: SCHEMA_URL.app, blueprintVersion: 1, name: 'BackOffice', targets: { web: 'vite-refine', api: 'dotnet-minimal' },
  })))
  const pages = [
    { name: 'Customers', kind: 'list', route: '/customers', fields: ['birthDate'] },
    { name: 'CreateCustomer', kind: 'create', route: '/customers/create', fields: ['fullName', 'email', 'birthDate'] },
  ]
  for (const [index, { fields, ...page }] of pages.entries()) {
    fs.writeFileSync(path.join(blueprint, 'pages', page.name + '.page.json'), serialize(pageSchema.parse({
      ...page, $schema: SCHEMA_URL.page, blueprintVersion: 1, id: 'pg_' + String(index + 1).padStart(26, '0'),
      resource: 'Customer', options: { fields },
    })))
  }
  await syncContract({ cwd: web, input, zod: true })
  const { EngineService, createStandaloneHost, loadEngine, startDevService } = await import(
    pathToFileURL(path.join(workspace, 'packages/dev-service/dist/index.js')).href)
  const host = createStandaloneHost(web)
  const engine = await loadEngine()
  const service = new EngineService({ host, engine, version: 'test' })
  await service.ejectBlueprint(pages.map(({ name }) => name))

  const server = await startDevService(host, { engine })
  try {
    const drift = async () => {
      const response = await fetch(server.url + '/@trivia/api/refine/drift')
      expect(response.status).toBe(200)
      const result = await response.json() as { data: { pages: unknown[] } }
      return result.data.pages
    }
    expect(await drift()).toEqual([])

    const model = modelSchema.parse(JSON.parse(fs.readFileSync(bank, 'utf8')))
    const customer = model.entities.find(({ name }) => name === 'Customer')!
    customer.fields = customer.fields.filter(({ name }) => name !== 'birthDate')
    fs.writeFileSync(path.join(blueprint, MODEL_DOC), serialize(model))
    buildContract(blueprint)
    await syncContract({ cwd: web, input, zod: true })

    expect(await drift()).toEqual([
      expect.objectContaining({ kind: 'form', file: 'src/pages/customers/create.tsx', issues: [
        expect.objectContaining({ code: 'missing_field', name: 'birthDate', fix: { label: expect.any(String), changes: [{ action: 'remove', field: 'birthDate' }] } }),
      ] }),
      expect.objectContaining({ kind: 'list', file: 'src/pages/customers/list.tsx', issues: [
        expect.objectContaining({ code: 'missing_field', name: 'birthDate', fix: { label: expect.any(String), changes: [{ action: 'remove', column: 'birthDate' }] } }),
      ] }),
    ])
  } finally {
    await server.close()
  }
}, 120_000)


function buildContract(blueprint: string, webDirectory?: string) {
  const generator = path.join(workspace, 'dotnet/src/Trivia.Blueprint.Codegen/Trivia.Blueprint.Codegen.csproj')
  const options = { cwd: root, encoding: 'utf8', timeout: 90_000 } as const
  execFileSync('dotnet', ['run', '--project', generator, '--configuration', 'Release', '--disable-build-servers', '--',
    'write', '--blueprint', blueprint, '--root', root, ...(webDirectory ? ['--web-dir', webDirectory] : [])], options)
  execFileSync('dotnet', ['build', 'src/BackOffice.Api/BackOffice.Api.csproj', '-warnaserror', '--disable-build-servers'], options)
}

it('writes the contract to an alternate web directory and keeps the irregular collection plural', async () => {
  const relative = 'clients/admin portal'
  const web = path.join(root, relative)
  const blueprint = path.join(web, 'blueprint')
  fs.mkdirSync(blueprint, { recursive: true })
  const model = modelSchema.parse(JSON.parse(fs.readFileSync(bank, 'utf8')))
  model.entities.find(({ name }) => name === 'Customer')!.plural = 'people'
  fs.writeFileSync(path.join(blueprint, MODEL_DOC), serialize(model))

  buildContract(blueprint, relative)
  expect(fs.readFileSync(path.join(root, 'src/BackOffice.AppHost/Program.cs'), 'utf8')).toContain('AddViteApp("web", "../../clients/admin portal")')
  const { manifest } = await syncContract({ cwd: web, input, zod: true })
  const resource = manifest.resources.find(({ name }) => name === 'Customer')!
  expect(resource.basePath).toBe('/api/v1/people')
  expect(refineName(resource)).toBe('people')
  expect(resource.operations.list?.operationId).toBe('listPeople')
  expect(fs.existsSync(path.join(root, 'web'))).toBe(false)
}, 120_000)
