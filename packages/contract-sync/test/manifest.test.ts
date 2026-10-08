import fsp from 'node:fs/promises'
import path from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'
import yaml from 'js-yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseSpecText } from '../src/adapters/rest-adapter.js'
import { runContractSync } from '../src/codegen/codegen.js'
import { generateManifest } from '../src/manifest/generator.js'
import type { ManifestOperation, ManifestResource, TriviaManifest } from '../src/manifest/types.js'
import { RefResolver, schemaHash } from '../src/spec/spec.js'
import { syncContract } from '../src/sync.js'
import { PACKAGE_DIR, exportedNames, fixture, makeProject, removeProject } from './helpers.js'

const schema = JSON.parse(await fsp.readFile(path.join(PACKAGE_DIR, 'manifest.schema.json'), 'utf8')) as Record<string, unknown>
// Strict, except that `"type": ["string", "null"]` (standard JSON Schema) is allowed.
const ajv = new Ajv2020.default({ allErrors: true, strict: true, allowUnionTypes: true })
const validate = ajv.compile<TriviaManifest>(schema)

function validationErrors(manifest: unknown): string[] {
  return validate(manifest) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ''}`)
}

/** Compact, exact view of what the classifier decided. */
function summary(resource: ManifestResource) {
  const op = (operation: ManifestOperation | null) =>
    operation === null
      ? null
      : {
          route: `${operation.method} ${operation.path}`,
          fns: [
            operation.sdkFn,
            operation.queryOptionsFn,
            operation.queryKeyFn,
            operation.infiniteQueryOptionsFn,
            operation.infiniteQueryKeyFn,
            operation.mutationFn,
          ].filter((fn): fn is string => fn !== null),
          ...('idParam' in operation ? { idParam: operation.idParam } : {}),
          ...('listItemsPath' in operation ? { listItemsPath: operation.listItemsPath } : {}),
        }
  return {
    name: resource.name,
    groupedBy: resource.groupedBy,
    basePath: resource.basePath,
    itemPath: resource.itemPath,
    primaryKey: resource.primaryKey,
    entityType: resource.entity?.typeName ?? null,
    list: op(resource.operations.list),
    get: op(resource.operations.get),
    create: op(resource.operations.create),
    update: op(resource.operations.update),
    delete: op(resource.operations.delete),
    custom: resource.customOperations.map((operation) => op(operation)),
  }
}

const manifests = new Map<string, { manifest: TriviaManifest; root: string }>()

beforeAll(async () => {
  for (const file of ['customers.openapi.json', 'orders.openapi.yaml', 'postgrest.swagger.json']) {
    const root = await makeProject()
    await fsp.mkdir(path.join(root, 'openapi'))
    await fsp.copyFile(fixture(file), path.join(root, 'openapi', file))
    const { manifest } = await syncContract({ input: `openapi/${file}`, cwd: root })
    manifests.set(file, { manifest, root })
  }
})

afterAll(async () => {
  for (const { root } of manifests.values()) await removeProject(root)
})

const get = (file: string): TriviaManifest => {
  const entry = manifests.get(file)
  if (!entry) throw new Error(`no manifest for ${file}`)
  return entry.manifest
}

describe('customers.openapi.json (OpenAPI 3.1)', () => {
  it('classifies Customer CRUD exactly and puts approve-kyc in customOperations', () => {
    expect(get('customers.openapi.json').resources.map(summary)).toEqual([
      {
        name: 'Customer',
        groupedBy: 'tag',
        basePath: '/api/v1/customers',
        itemPath: '/api/v1/customers/{id}',
        primaryKey: 'id',
        entityType: 'CustomerDto',
        list: {
          route: 'GET /api/v1/customers',
          fns: ['listCustomers', 'listCustomersOptions', 'listCustomersQueryKey', 'listCustomersInfiniteOptions', 'listCustomersInfiniteQueryKey'],
          listItemsPath: 'items',
        },
        get: {
          route: 'GET /api/v1/customers/{id}',
          fns: ['getCustomerById', 'getCustomerByIdOptions', 'getCustomerByIdQueryKey'],
          idParam: 'id',
        },
        create: { route: 'POST /api/v1/customers', fns: ['createCustomer', 'createCustomerMutation'] },
        update: { route: 'PUT /api/v1/customers/{id}', fns: ['updateCustomer', 'updateCustomerMutation'], idParam: 'id' },
        delete: { route: 'DELETE /api/v1/customers/{id}', fns: ['deleteCustomer', 'deleteCustomerMutation'], idParam: 'id' },
        custom: [
          { route: 'POST /api/v1/customers/{id}/approve-kyc', fns: ['approveCustomerKyc', 'approveCustomerKycMutation'] },
        ],
      },
      {
        name: 'Health',
        groupedBy: 'path',
        basePath: null,
        itemPath: null,
        primaryKey: null,
        entityType: null,
        list: null,
        get: null,
        create: null,
        update: null,
        delete: null,
        custom: [{ route: 'GET /api/v1/health', fns: ['getHealth', 'getHealthOptions', 'getHealthQueryKey'] }],
      },
    ])
  })

  it('records page pagination with the total, plus parameter defaults for the binder', () => {
    const list = get('customers.openapi.json').resources[0]?.operations.list
    expect(list?.pagination).toEqual({
      style: 'page',
      pageParam: 'page',
      pageSizeParam: 'pageSize',
      limitParam: null,
      offsetParam: null,
      cursorParam: null,
      totalPath: 'total',
      nextCursorPath: null,
    })
    expect(list?.parameters.map((p) => [p.name, p.in, p.type, p.default ?? null])).toEqual([
      ['page', 'query', 'integer', 1],
      ['pageSize', 'query', 'integer', 20],
      ['search', 'query', 'string', null],
      ['status', 'query', 'string', null],
    ])
    expect(list?.parameters[3]?.enum).toEqual(['pending', 'active', 'suspended'])
  })

  it('summarizes entity fields with type, format, required, enum and nullable', () => {
    const fields = get('customers.openapi.json').resources[0]?.entity?.fields ?? []
    const view = fields.map((f) => [f.name, f.type, f.format, f.required, f.nullable, f.readOnly, f.enum, f.ref, f.items?.type ?? null])
    expect(view).toEqual([
      ['id', 'string', 'uuid', true, false, true, null, null, null],
      ['fullName', 'string', null, true, false, false, null, null, null],
      ['email', 'string', 'email', true, false, false, null, null, null],
      ['phone', 'string', null, false, true, false, null, null, null],
      ['status', 'string', null, true, false, false, ['pending', 'active', 'suspended'], '#/components/schemas/CustomerStatus', null],
      ['kycStatus', 'string', null, true, false, false, ['not_started', 'in_review', 'approved', 'rejected'], '#/components/schemas/KycStatus', null],
      ['creditLimit', 'number', 'double', false, false, false, null, null, null],
      ['birthDate', 'string', 'date', false, true, false, null, null, null],
      ['tags', 'array', null, false, false, false, null, null, 'string'],
      ['address', 'object', null, false, false, false, null, '#/components/schemas/Address', null],
      ['createdAt', 'string', 'date-time', true, false, true, null, null, null],
    ])
  })

  it('records project-relative module paths and import paths through the @/ ↔ src/ alias', () => {
    const manifest = get('customers.openapi.json')
    expect(manifest.source).toEqual({
      location: 'openapi/customers.openapi.json',
      format: 'openapi-3.1',
      specVersion: '3.1.0',
      title: 'Customer API',
      apiVersion: '1.4.0',
      style: 'rest',
      excludedOperations: [],
    })
    expect(manifest.modules).toEqual({
      outputDir: 'src/api/generated',
      queries: { file: 'src/api/generated/@tanstack/react-query.gen.ts', importPath: '@/api/generated/@tanstack/react-query.gen' },
      sdk: { file: 'src/api/generated/sdk.gen.ts', importPath: '@/api/generated/sdk.gen' },
      types: { file: 'src/api/generated/types.gen.ts', importPath: '@/api/generated/types.gen' },
      client: { file: 'src/api/generated/client.gen.ts', importPath: '@/api/generated/client.gen' },
      index: { file: 'src/api/generated/index.ts', importPath: '@/api/generated' },
      zod: null,
    })
    expect(manifest.generator).toEqual({
      name: '@trivia/contract-sync',
      version: '0.1.0',
      heyApi: '0.99.0',
      plugins: ['@hey-api/client-fetch', '@hey-api/typescript', '@hey-api/sdk', '@tanstack/react-query'],
    })
    expect(manifest).not.toHaveProperty('generatedAt')
  })
})

describe('orders.openapi.yaml (OpenAPI 3.0, operations without operationId)', () => {
  it('classifies exactly, using the names hey-api derived from method + path', () => {
    expect(get('orders.openapi.yaml').resources.map(summary)).toEqual([
      {
        name: 'InventoryItem',
        groupedBy: 'x-trivia-resource',
        basePath: '/inventory/items',
        itemPath: '/inventory/items/{sku}',
        primaryKey: 'sku',
        entityType: 'StockItem',
        list: {
          route: 'GET /inventory/items',
          fns: ['listStock', 'listStockOptions', 'listStockQueryKey', 'listStockInfiniteOptions', 'listStockInfiniteQueryKey'],
          listItemsPath: 'data',
        },
        get: {
          route: 'GET /inventory/items/{sku}',
          fns: ['getInventoryItemsBySku', 'getInventoryItemsBySkuOptions', 'getInventoryItemsBySkuQueryKey'],
          idParam: 'sku',
        },
        create: null,
        update: { route: 'PUT /inventory/items/{sku}', fns: ['replaceStockItem', 'replaceStockItemMutation'], idParam: 'sku' },
        delete: null,
        custom: [],
      },
      {
        name: 'Order',
        groupedBy: 'tag',
        basePath: '/orders',
        itemPath: '/orders/{orderNumber}',
        primaryKey: 'orderNumber',
        entityType: 'Order',
        list: {
          route: 'GET /orders',
          fns: ['getOrders', 'getOrdersOptions', 'getOrdersQueryKey', 'getOrdersInfiniteOptions', 'getOrdersInfiniteQueryKey'],
          listItemsPath: null,
        },
        get: {
          route: 'GET /orders/{orderNumber}',
          fns: ['getOrdersByOrderNumber', 'getOrdersByOrderNumberOptions', 'getOrdersByOrderNumberQueryKey'],
          idParam: 'orderNumber',
        },
        create: { route: 'POST /orders', fns: ['postOrders', 'postOrdersMutation'] },
        update: {
          route: 'PATCH /orders/{orderNumber}',
          fns: ['patchOrdersByOrderNumber', 'patchOrdersByOrderNumberMutation'],
          idParam: 'orderNumber',
        },
        delete: { route: 'DELETE /orders/{orderNumber}', fns: ['cancelOrder', 'cancelOrderMutation'], idParam: 'orderNumber' },
        custom: [
          {
            route: 'POST /orders/{orderNumber}/ship',
            fns: ['postOrdersByOrderNumberShip', 'postOrdersByOrderNumberShipMutation'],
          },
        ],
      },
      {
        name: 'Report',
        groupedBy: 'path',
        basePath: null,
        itemPath: null,
        primaryKey: null,
        entityType: null,
        list: null,
        get: null,
        create: null,
        update: null,
        delete: null,
        custom: [{ route: 'GET /reports/daily', fns: ['getReportsDaily', 'getReportsDailyOptions', 'getReportsDailyQueryKey'] }],
      },
    ])
  })

  it('detects offset and cursor pagination, nullable via `nullable: true`, and $ref’d components', () => {
    const [inventory, order] = get('orders.openapi.yaml').resources
    expect(order?.operations.list?.pagination).toMatchObject({ style: 'offset', limitParam: 'limit', offsetParam: 'offset' })
    expect(order?.operations.list?.parameters.map((p) => [p.name, p.default ?? null])).toEqual([
      ['limit', 50],
      ['offset', 0],
      ['status', null],
    ])
    expect(inventory?.operations.list?.pagination).toMatchObject({
      style: 'cursor',
      cursorParam: 'cursor',
      limitParam: 'limit',
      nextCursorPath: 'nextCursor',
    })
    // requestBody via #/components/requestBodies, response via #/components/responses.
    expect(order?.operations.create?.requestBody).toMatchObject({
      required: true,
      contentType: 'application/json',
      schemaRef: '#/components/schemas/OrderInput',
      zodSchema: null,
    })
    expect(order?.operations.create?.requestBody?.fields?.length).toBeGreaterThan(0)
    expect(order?.operations.create?.response).toEqual({
      status: '201',
      contentType: 'application/json',
      schemaRef: '#/components/schemas/Order',
      isArray: false,
    })
    const fields = new Map(order?.entity?.fields.map((f) => [f.name, f]))
    expect(fields.get('customerEmail')).toMatchObject({ nullable: true, format: 'email', required: false })
    expect(fields.get('lineItems')).toMatchObject({
      type: 'array',
      required: true,
      items: { type: 'object', ref: '#/components/schemas/LineItem', format: null, enum: null },
    })
    // Recursive schemas (Warehouse.parent → Warehouse) are summarized one level deep.
    expect(inventory?.entity?.fields.find((f) => f.name === 'warehouse')).toMatchObject({
      type: 'object',
      ref: '#/components/schemas/Warehouse',
    })
  })
})

describe('postgrest.swagger.json (Swagger 2.0, PostgREST)', () => {
  it('maps table CRUD onto collection paths with row filters, never inventing item paths', () => {
    expect(get('postgrest.swagger.json').resources.map(summary)).toEqual([
      {
        name: 'Customer',
        groupedBy: 'tag',
        basePath: '/customers',
        itemPath: null,
        primaryKey: 'id',
        entityType: 'Customers',
        list: {
          route: 'GET /customers',
          fns: ['getCustomers', 'getCustomersOptions', 'getCustomersQueryKey', 'getCustomersInfiniteOptions', 'getCustomersInfiniteQueryKey'],
          listItemsPath: null,
        },
        get: {
          route: 'GET /customers',
          fns: ['getCustomers', 'getCustomersOptions', 'getCustomersQueryKey', 'getCustomersInfiniteOptions', 'getCustomersInfiniteQueryKey'],
          idParam: 'id',
        },
        create: { route: 'POST /customers', fns: ['postCustomers', 'postCustomersMutation'] },
        update: { route: 'PATCH /customers', fns: ['patchCustomers', 'patchCustomersMutation'], idParam: 'id' },
        delete: { route: 'DELETE /customers', fns: ['deleteCustomers', 'deleteCustomersMutation'], idParam: 'id' },
        custom: [],
      },
      {
        name: 'Org',
        groupedBy: 'tag',
        basePath: '/orgs',
        itemPath: null,
        primaryKey: 'id',
        entityType: 'Orgs',
        list: {
          route: 'GET /orgs',
          fns: ['getOrgs', 'getOrgsOptions', 'getOrgsQueryKey', 'getOrgsInfiniteOptions', 'getOrgsInfiniteQueryKey'],
          listItemsPath: null,
        },
        get: {
          route: 'GET /orgs',
          fns: ['getOrgs', 'getOrgsOptions', 'getOrgsQueryKey', 'getOrgsInfiniteOptions', 'getOrgsInfiniteQueryKey'],
          idParam: 'id',
        },
        create: null,
        update: null,
        delete: null,
        custom: [],
      },
      {
        name: 'Rpc',
        groupedBy: 'path',
        basePath: null,
        itemPath: null,
        primaryKey: null,
        entityType: null,
        list: null,
        get: null,
        create: null,
        update: null,
        delete: null,
        custom: [
          { route: 'GET /rpc/approve_kyc', fns: ['getRpcApproveKyc', 'getRpcApproveKycOptions', 'getRpcApproveKycQueryKey'] },
          { route: 'POST /rpc/approve_kyc', fns: ['postRpcApproveKyc', 'postRpcApproveKycMutation'] },
        ],
      },
    ])
  })

  it('records the PostgREST facts a binder needs (filter, single-object media type, Prefer, safety)', () => {
    const manifest = get('postgrest.swagger.json')
    expect(manifest.source.style).toBe('postgrest')
    expect(manifest.source.excludedOperations).toEqual(['GET /'])
    const customer = manifest.resources[0]
    expect(customer?.operations.get?.postgrest).toEqual({
      rowFilter: { param: 'id', template: 'eq.{value}' },
      singleObjectAccept: 'application/vnd.pgrst.object+json',
      returnRepresentation: null,
      filterRequired: false,
    })
    // The declared body is an array even for the single-row read; the manifest says so.
    expect(customer?.operations.get?.response).toMatchObject({ status: '200', isArray: true })
    expect(customer?.operations.create?.postgrest).toEqual({
      rowFilter: null,
      singleObjectAccept: null,
      returnRepresentation: 'return=representation',
      filterRequired: false,
    })
    for (const write of [customer?.operations.update, customer?.operations.delete]) {
      expect(write?.postgrest).toEqual({
        rowFilter: { param: 'id', template: 'eq.{value}' },
        singleObjectAccept: null,
        returnRepresentation: 'return=representation',
        filterRequired: true,
      })
    }
    expect(customer?.operations.list?.pagination).toMatchObject({ style: 'offset', limitParam: 'limit', offsetParam: 'offset' })
    const fields = new Map(customer?.entity?.fields.map((f) => [f.name, f]))
    // NOT NULL columns are PostgREST's `required`; the others are nullable columns.
    expect(fields.get('credit_limit')).toMatchObject({ required: false, nullable: true, format: 'numeric', type: 'number' })
    expect(fields.get('id')).toMatchObject({ required: true, nullable: false, format: 'uuid', default: 'gen_random_uuid()' })
    expect(fields.get('status')).toMatchObject({ enum: ['pending', 'active', 'suspended'], default: 'pending' })
  })
})

describe('every manifest', () => {
  const files = ['customers.openapi.json', 'orders.openapi.yaml', 'postgrest.swagger.json']

  it.each(files)('%s validates against manifest.schema.json', (file) => {
    expect(validationErrors(get(file))).toEqual([])
  })

  it('the schema validation is not vacuous: broken manifests are rejected', () => {
    const manifest = structuredClone(get('customers.openapi.json'))
    const customer = manifest.resources[0] as unknown as Record<string, unknown>
    customer['name'] = 'customer-lowercase'
    const list = (customer['operations'] as Record<string, Record<string, unknown>>)['list'] as Record<string, unknown>
    delete list['listItemsPath']
    list['idParam'] = 'id'
    const errors = validationErrors({ ...manifest, generatedAt: '2026-10-07T00:00:00Z' })
    expect(errors.some((error) => error.includes('must NOT have additional properties'))).toBe(true)
    expect(errors.some((error) => error.startsWith('/resources/0/name'))).toBe(true)
    expect(errors.some((error) => error.includes("must have required property 'listItemsPath'"))).toBe(true)
  })

  it.each(files)('%s: every function name is exported by the generated code', async (file) => {
    const entry = manifests.get(file)
    if (!entry) throw new Error('missing manifest')
    const { manifest, root } = entry
    const queries = exportedNames(path.join(root, manifest.modules.queries.file))
    const sdk = exportedNames(path.join(root, manifest.modules.sdk.file))
    const types = exportedNames(path.join(root, manifest.modules.types.file))
    const operations: ManifestOperation[] = manifest.resources.flatMap((resource) => [
      ...Object.values(resource.operations).filter((operation) => operation !== null),
      ...resource.customOperations,
    ])
    expect(operations.length).toBeGreaterThan(0)
    for (const operation of operations) {
      expect(sdk, `${operation.method} ${operation.path}`).toContain(operation.sdkFn)
      for (const fn of [
        operation.queryOptionsFn,
        operation.queryKeyFn,
        operation.infiniteQueryOptionsFn,
        operation.infiniteQueryKeyFn,
        operation.mutationFn,
      ]) {
        if (fn !== null) expect(queries, `${operation.method} ${operation.path}`).toContain(fn)
      }
      // GETs are queries, everything else is a mutation.
      expect(operation.queryOptionsFn !== null).toBe(operation.method === 'GET')
      expect(operation.mutationFn !== null).toBe(operation.method !== 'GET')
    }
    for (const resource of manifest.resources) {
      if (resource.entity?.typeName) expect(types).toContain(resource.entity.typeName)
    }
  })

  it.each(files)('%s: resources and custom operations are sorted deterministically', (file) => {
    const { resources } = get(file)
    const names = resources.map((resource) => resource.name)
    expect(names).toEqual([...names].sort())
    for (const resource of resources) {
      const keys = resource.customOperations.map((operation) => `${operation.path} ${operation.method}`)
      expect(keys).toEqual([...keys].sort())
    }
  })
})

describe('schemaHash', () => {
  it('hashes the canonical spec: format and key order do not matter, content does', async () => {
    const json = JSON.parse(await fsp.readFile(fixture('customers.openapi.json'), 'utf8')) as Record<string, unknown>
    const asYaml = parseSpecText(yaml.dump(json), 'customers.yaml', 'yaml')
    const reordered = Object.fromEntries(Object.entries(json).reverse())
    expect(schemaHash(asYaml)).toBe(schemaHash(json))
    expect(schemaHash(reordered)).toBe(schemaHash(json))
    expect(schemaHash(json)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(get('customers.openapi.json').schemaHash).toBe(schemaHash(json))
    const changed = structuredClone(json)
    ;(changed['info'] as Record<string, unknown>)['version'] = '1.4.1'
    expect(schemaHash(changed)).not.toBe(schemaHash(json))
  })
})

describe('$ref resolution', () => {
  it('fails loudly on a $ref cycle instead of looping', () => {
    const refs = new RefResolver({
      components: { schemas: { A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' } } },
    })
    expect(() => refs.resolve({ $ref: '#/components/schemas/A' })).toThrow(/\$ref cycle/)
  })

  it('refuses external refs and reports dangling ones', () => {
    const refs = new RefResolver({ components: { schemas: {} } })
    expect(() => refs.resolve({ $ref: 'other.yaml#/Foo' })).toThrow(/External \$ref/)
    expect(() => refs.resolve({ $ref: '#/components/schemas/Missing' })).toThrow(/does not resolve/)
  })

  it('decodes JSON-pointer escapes', () => {
    const refs = new RefResolver({ paths: { '/a/{id}': { get: { ok: true } } } })
    expect(refs.get('#/paths/~1a~1%7Bid%7D/get')).toEqual({ ok: true })
  })
})

describe('more spec shapes, through the real pipeline', () => {
  let root: string
  beforeAll(async () => {
    root = await makeProject()
  })
  afterAll(async () => {
    await removeProject(root)
  })

  async function sync(name: string, spec: unknown) {
    const file = path.join(root, `${name}.json`)
    await fsp.writeFile(file, JSON.stringify(spec))
    return syncContract({ input: `${name}.json`, cwd: root, outputDir: `src/${name}`, manifestPath: `${name}.manifest.json` })
  }

  it('classifies a plain-REST Swagger 2.0 spec (definitions, in: body, response schema)', async () => {
    const { manifest } = await sync('pets', {
      swagger: '2.0',
      info: { title: 'Pets', version: '1' },
      basePath: '/v1',
      paths: {
        '/pets': {
          get: {
            tags: ['pets'],
            operationId: 'listPets',
            parameters: [{ name: 'limit', in: 'query', type: 'integer', default: 25 }],
            responses: { 200: { description: 'ok', schema: { type: 'array', items: { $ref: '#/definitions/Pet' } } } },
          },
          post: {
            tags: ['pets'],
            operationId: 'createPet',
            parameters: [{ name: 'pet', in: 'body', required: true, schema: { $ref: '#/definitions/NewPet' } }],
            responses: { 201: { description: 'created', schema: { $ref: '#/definitions/Pet' } } },
          },
        },
        '/pets/{petId}': {
          get: {
            tags: ['pets'],
            operationId: 'showPetById',
            parameters: [{ name: 'petId', in: 'path', required: true, type: 'string' }],
            responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Pet' } } },
          },
        },
      },
      definitions: {
        Pet: {
          type: 'object',
          required: ['id', 'name'],
          properties: { id: { type: 'integer', format: 'int64' }, name: { type: 'string' }, tag: { type: 'string', 'x-nullable': true } },
        },
        NewPet: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      },
    })
    expect(manifest.source.style).toBe('rest')
    expect(manifest.resources.map(summary)).toEqual([
      {
        name: 'Pet',
        groupedBy: 'tag',
        basePath: '/pets',
        itemPath: '/pets/{petId}',
        primaryKey: 'id',
        entityType: 'Pet',
        // `limit` is not one of hey-api's pagination keywords, so no infinite factory exists.
        list: { route: 'GET /pets', fns: ['listPets', 'listPetsOptions', 'listPetsQueryKey'], listItemsPath: null },
        get: { route: 'GET /pets/{petId}', fns: ['showPetById', 'showPetByIdOptions', 'showPetByIdQueryKey'], idParam: 'petId' },
        create: { route: 'POST /pets', fns: ['createPet', 'createPetMutation'] },
        update: null,
        delete: null,
        custom: [],
      },
    ])
    expect(manifest.resources[0]?.operations.create?.requestBody).toMatchObject({
      required: true,
      contentType: 'application/json',
      schemaRef: '#/definitions/NewPet',
      zodSchema: null,
    })
    // Swagger 2.0 `in: body` schemas give their fields too.
    expect(manifest.resources[0]?.operations.create?.requestBody?.fields?.map((f) => [f.name, f.required])).toEqual([['name', true]])
    expect(manifest.resources[0]?.entity?.fields.find((f) => f.name === 'tag')?.nullable).toBe(true)
    expect(validationErrors(manifest)).toEqual([])
  })

  it('finds rows under allOf-composed page envelopes', async () => {
    const { manifest } = await sync('envelope', {
      openapi: '3.0.3',
      info: { title: 'Envelope', version: '1' },
      paths: {
        '/invoices': {
          get: {
            operationId: 'listInvoices',
            parameters: [{ name: 'skip', in: 'query', schema: { type: 'integer' } }, { name: 'take', in: 'query', schema: { type: 'integer' } }],
            responses: {
              200: {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      allOf: [
                        { $ref: '#/components/schemas/Page' },
                        { type: 'object', properties: { results: { type: 'array', items: { $ref: '#/components/schemas/Invoice' } } } },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Page: { type: 'object', properties: { totalCount: { type: 'integer' } } },
          Invoice: { type: 'object', properties: { number: { type: 'string' } } },
        },
      },
    })
    const list = manifest.resources[0]?.operations.list
    expect(manifest.resources[0]?.name).toBe('Invoice')
    expect(list?.listItemsPath).toBe('results')
    expect(list?.pagination).toMatchObject({ style: 'offset', offsetParam: 'skip', limitParam: 'take', totalPath: 'totalCount' })
    expect(manifest.resources[0]?.entity?.typeName).toBe('Invoice')
  })

  it('rejects an x-trivia-resource that is not an identifier, before touching the project', async () => {
    const outputDir = path.join(root, 'src/bad-resource')
    await expect(
      sync('bad-resource', {
        openapi: '3.1.0',
        info: { title: 'Bad', version: '1' },
        paths: { '/things': { get: { 'x-trivia-resource': 'my things', responses: { 200: { description: 'ok' } } } } },
      }),
    ).rejects.toMatchObject({ code: 'input_invalid' })
    await expect(fsp.access(outputDir)).rejects.toThrow()
  })

  it('fails loudly when two groups resolve to the same resource name', async () => {
    await expect(
      sync('collision', {
        openapi: '3.1.0',
        info: { title: 'Collision', version: '1' },
        paths: {
          '/a/users': {
            get: {
              tags: ['Admin'],
              responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } } },
            },
          },
          '/b/users': {
            get: {
              tags: ['Public'],
              responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } } },
            },
          },
        },
        components: { schemas: { User: { type: 'object', properties: { id: { type: 'string' } } } } },
      }),
    ).rejects.toMatchObject({ code: 'classification_conflict' })
  })

  it('generateManifest over runContractSync output equals the one-shot pipeline', async () => {
    const codegen = await runContractSync({ input: fixture('orders.openapi.yaml'), outputDir: 'src/two-step', cwd: root })
    const manifest = generateManifest(codegen.spec, { schemaSource: fixture('orders.openapi.yaml'), generatedDir: 'src/two-step', projectRoot: root })
    const { manifest: oneShot } = await syncContract({ input: fixture('orders.openapi.yaml'), cwd: root, outputDir: 'src/two-step', manifestPath: 'two.json' })
    expect(manifest).toEqual(oneShot)
  })

  it('import paths follow the alias, or are null outside it', async () => {
    const codegen = await runContractSync({ input: fixture('orders.openapi.yaml'), outputDir: 'app/generated', cwd: root })
    const outside = generateManifest(codegen.spec, { schemaSource: 'x.yaml', generatedDir: 'app/generated', projectRoot: root })
    expect(outside.modules.queries).toEqual({ file: 'app/generated/@tanstack/react-query.gen.ts', importPath: null })
    const aliased = generateManifest(codegen.spec, {
      schemaSource: 'x.yaml',
      generatedDir: 'app/generated',
      projectRoot: root,
      importBase: { alias: '~/', dir: 'app' },
    })
    expect(aliased.modules.queries.importPath).toBe('~/generated/@tanstack/react-query.gen')
    const none = generateManifest(codegen.spec, { schemaSource: 'x.yaml', generatedDir: 'app/generated', projectRoot: root, importBase: false })
    expect(none.modules.index.importPath).toBeNull()
  })
})
