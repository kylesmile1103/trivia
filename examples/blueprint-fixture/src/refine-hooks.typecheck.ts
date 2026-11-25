import type {
  useCreate, useCustom, useCustomMutation, useDelete, useGo, useList, useNotification, useOne, useUpdate,
} from '@refinedev/core'
import type { useTable } from '@refinedev/react-table'

import { queryHooks, queryStatus } from '../../../packages/blueprint-compiler/src/targets/vite-refine/refine-hooks.js'

type Path<T, Key extends keyof T & string> = Key | `${Key}.${keyof NonNullable<T[Key]> & string}`

// These assignments make the compiler's recorded result paths depend on the installed declarations.
export const listFields: Record<'items' | 'total', Path<ReturnType<typeof useList>, 'result'>> =
  queryHooks.list.fields
export const oneFields: Record<'record', Path<ReturnType<typeof useOne>, 'result'>> =
  queryHooks.one.fields
export const customFields: Record<'result', Path<ReturnType<typeof useCustom>, 'result'>> =
  queryHooks.custom.fields
export const statusFields: Record<'isLoading' | 'error' | 'refetch', Path<ReturnType<typeof useList>, 'query'>> =
  queryStatus

// Check the callable shape as well as the return properties.
export function checkHooks(hooks: {
  table: ReturnType<typeof useTable>
  create: ReturnType<typeof useCreate>
  update: ReturnType<typeof useUpdate>
  remove: ReturnType<typeof useDelete>
  custom: ReturnType<typeof useCustomMutation>
  go: ReturnType<typeof useGo>
  notification: ReturnType<typeof useNotification>
}) {
  const resource = 'accounts'
  const values = { name: 'Savings' }
  return {
    rows: hooks.table.reactTable.getRowModel().rows,
    result: hooks.table.refineCore.result,
    create: hooks.create.mutateAsync({ resource, values }),
    update: hooks.update.mutateAsync({ resource, values, id: 'a1' }),
    remove: hooks.remove.mutateAsync({ resource, id: 'a1' }),
    custom: hooks.custom.mutateAsync({ url: '/accounts/a1/close', method: 'post', values }),
    go: hooks.go({ to: '/accounts' }),
    notification: hooks.notification.open?.({ type: 'success', message: 'Saved' }),
  }
}
