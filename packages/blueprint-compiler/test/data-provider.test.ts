import { expect, it, vi } from 'vitest'

const moduleUrl = new URL('../templates/vite-refine/src/providers/data-provider.ts', import.meta.url)

async function fixture(respond: () => Response = () => Response.json({ items: [{ id: 7 }], total: 42 })) {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => respond())
  const { createDataProvider } = await import(moduleUrl.href)
  return { provider: createDataProvider(send), send }
}

function requestUrl(send: ReturnType<typeof vi.fn<typeof fetch>>, index = 0) {
  return new URL(String(send.mock.calls[index]?.[0]), 'http://test.local')
}

it('FR-AS-06 builds a paged request with ordered sorters, repeated filters and encoded values', async () => {
  const { provider, send } = await fixture()
  const filterValues = [
    ['eq', 'a:b+c@example.test', 'a:b+c@example.test'], ['ne', 'active', 'active'],
    ['lt', 8, '8'], ['lte', 9, '9'], ['gt', 2, '2'], ['gte', 3, '3'],
    ['contains', 'a plus +', 'a plus +'], ['startswith', 'A/', 'A/'],
    ['in', [7, 8], '7,8'], ['null', false, 'false'],
  ] as const
  const result = await provider.getList({
    resource: 'people',
    pagination: { currentPage: 2, pageSize: 5 },
    sorters: [{ field: 'fullName', order: 'asc' }, { field: 'createdAt', order: 'desc' }],
    filters: filterValues.map(([operator, value]) => ({ field: 'field', operator, value })),
  })
  expect(result).toEqual({ data: [{ id: 7 }], total: 42 })
  const url = requestUrl(send)
  expect(url.pathname).toBe('/api/v1/people')
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ page: '2', pageSize: '5', sort: 'fullName,-createdAt' })
  expect(url.searchParams.getAll('filter')).toEqual(filterValues.map(([operator, , value]) => 'field:' + operator + ':' + value))
})

it('refuses unsupported filters before making a request', async () => {
  const { provider, send } = await fixture()
  await expect(provider.getList({ resource: 'customers', filters: [{ field: 'name', operator: 'endswith', value: 'a' }] }))
    .rejects.toThrow(/endswith/)
  await expect(provider.getList({ resource: 'customers', filters: [{ operator: 'or', value: [] }] }))
    .rejects.toThrow(/\bor\b/)
  expect(send).not.toHaveBeenCalled()
})

it('looks up many ids with bounded requests and handles an empty id list', async () => {
  const { provider, send } = await fixture()
  expect(await provider.getMany({ resource: 'customers', ids: [] })).toEqual({ data: [] })
  expect(send).not.toHaveBeenCalled()

  const ids = Array.from({ length: 201 }, (_, index) => index + 1)
  await provider.getMany({ resource: 'customers', ids })
  expect(send).toHaveBeenCalledTimes(2)
  expect(requestUrl(send).searchParams.get('filter')).toBe('id:in:' + ids.slice(0, 200).join(','))
  expect(requestUrl(send).searchParams.get('pageSize')).toBe('200')
  expect(requestUrl(send, 1).searchParams.get('filter')).toBe('id:in:201')
})

it('routes mutations and custom calls under /api/v1', async () => {
  const { provider, send } = await fixture(() => Response.json({ id: 7 }))
  await provider.getOne({ resource: 'customers', id: 7 })
  await provider.create({ resource: 'customers', variables: { fullName: 'Jane' } })
  await provider.update({ resource: 'customers', id: 7, variables: { fullName: 'Jane' } })
  send.mockImplementationOnce(async () => new Response(null, { status: 204 }))
  expect(await provider.deleteOne({ resource: 'customers', id: 7 })).toEqual({ data: { id: 7 } })
  const result = await provider.custom({
    url: '/api/v1/customers/7/approve-kyc?keep=1', method: 'post',
    headers: { 'x-test': 'yes' }, query: { option: ['one', 'two'] }, payload: { reason: 'reviewed' },
  })

  expect(result).toEqual({ data: { id: 7 } })
  expect(send.mock.calls.slice(0, 4).map(([url, init]) => [url, init?.method])).toEqual([
    ['/api/v1/customers/7', 'GET'], ['/api/v1/customers', 'POST'],
    ['/api/v1/customers/7', 'PUT'], ['/api/v1/customers/7', 'DELETE'],
  ])
  expect(requestUrl(send, 4).searchParams.getAll('option')).toEqual(['one', 'two'])
  expect(requestUrl(send, 4).searchParams.get('keep')).toBe('1')
  expect(new Headers(send.mock.calls[4]?.[1]?.headers).get('x-test')).toBe('yes')
  expect(send.mock.calls[4]?.[1]?.body).toBe('{"reason":"reviewed"}')
  await expect(provider.custom({ url: 'https://elsewhere.test/api/v1/customers', method: 'get' })).rejects.toThrow(/same.origin/i)
  expect(send).toHaveBeenCalledTimes(5)
})

it('preserves problem detail and field errors for Refine', async () => {
  const { provider, send } = await fixture(() => Response.json({
    title: 'Invalid data', detail: 'Correct the highlighted values.', errors: { email: ['Invalid address.'] },
  }, { status: 400 }))
  await expect(provider.create({ resource: 'customers', variables: { email: 'wrong' } })).rejects.toMatchObject({
    message: 'Correct the highlighted values.', statusCode: 400, errors: { email: ['Invalid address.'] },
  })
  send.mockImplementationOnce(async () => new Response('Offline', { status: 503, statusText: 'Service Unavailable' }))
  await expect(provider.getList({ resource: 'customers' })).rejects.toMatchObject({
    message: 'Service Unavailable', statusCode: 503,
  })
})
