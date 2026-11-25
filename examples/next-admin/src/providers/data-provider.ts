// The app's data provider: Refine's CRUD calls against the back-office API
// (openapi/bank.openapi.json). Lists page with ?page&pageSize, sort with ?sort&order, and
// filter with `field=value` (comma list for "in"), `field_like`, `field_gte` and `field_lte`.

import type { BaseRecord, CrudFilter, DataProvider, HttpError } from '@refinedev/core'

const API_URL = '/api/v1'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as { title?: string; detail?: string }
    const error: HttpError = { message: problem.detail ?? problem.title ?? response.statusText, statusCode: response.status }
    throw error
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

function filterParams(filters: CrudFilter[] | undefined, params: URLSearchParams): void {
  for (const filter of filters ?? []) {
    if (!('field' in filter) || filter.value === undefined || filter.value === null || filter.value === '') continue
    const { field, operator, value } = filter
    const list = Array.isArray(value) ? value : [value]
    if (operator === 'contains') params.set(`${field}_like`, String(value))
    else if (operator === 'gte' || operator === 'gt') params.set(`${field}_gte`, String(value))
    else if (operator === 'lte' || operator === 'lt') params.set(`${field}_lte`, String(value))
    else if (operator === 'between') {
      if (list[0] != null) params.set(`${field}_gte`, String(list[0]))
      if (list[1] != null) params.set(`${field}_lte`, String(list[1]))
    } else if (operator === 'eq' || operator === 'in') {
      if (list.length > 0) params.set(field, list.map(String).join(','))
    }
  }
}

export const dataProvider: DataProvider = {
  getApiUrl: () => API_URL,

  getList: async ({ resource, pagination, sorters, filters }) => {
    const params = new URLSearchParams()
    if (pagination?.mode !== 'off') {
      params.set('page', String(pagination?.currentPage ?? 1))
      params.set('pageSize', String(pagination?.pageSize ?? 10))
    }
    const sorter = sorters?.[0]
    if (sorter) {
      params.set('sort', sorter.field)
      params.set('order', sorter.order)
    }
    filterParams(filters, params)
    const page = await request<{ items: BaseRecord[]; total: number }>('GET', `/${resource}?${params}`)
    return { data: page.items as never, total: page.total }
  },

  getOne: async ({ resource, id }) => ({ data: await request('GET', `/${resource}/${id}`) }),

  getMany: async ({ resource, ids }) => ({
    data: (await Promise.all(ids.map((id) => request<BaseRecord>('GET', `/${resource}/${id}`)))) as never,
  }),

  create: async ({ resource, variables }) => ({ data: await request('POST', `/${resource}`, variables) }),

  update: async ({ resource, id, variables }) => ({ data: await request('PUT', `/${resource}/${id}`, variables) }),

  deleteOne: async ({ resource, id }) => ({ data: (await request('DELETE', `/${resource}/${id}`)) ?? ({ id } as never) }),
}
