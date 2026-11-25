// Verified against @refinedev/core 5.0.12 and @refinedev/react-table 6.0.1 in refine-admin.
// useList returns result.data (rows) and result.total (possibly undefined).
// useOne returns the record itself in result (undefined before it loads).
// useCustom returns result.data. All three keep status and refetch on query; they accept
// queryOptions.enabled. useTable returns { reactTable, refineCore }, with rows on reactTable.
// useCreate/useUpdate expose mutateAsync on their result. useDelete/useCustomMutation also
// expose mutateAsync at the top level. CRUD takes resource, values for create/update and id
// for update/delete. Custom mutations take url, method and values.
// useGo() takes { to }. useNotification() exposes optional open({ type, message }).

export const queryHooks = {
  list: { hook: 'useList', fields: { items: 'result.data', total: 'result.total' } },
  one: { hook: 'useOne', fields: { record: 'result' } },
  custom: { hook: 'useCustom', fields: { result: 'result.data' } },
} as const

export const queryStatus = {
  isLoading: 'query.isLoading',
  error: 'query.error',
  refetch: 'query.refetch',
} as const
