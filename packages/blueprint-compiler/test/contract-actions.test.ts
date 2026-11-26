import { runInNewContext } from 'node:vm'

import { loadBlueprint, pageDocPath, SCHEMA_URL } from '@trivia/blueprint'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

import { compilePage, projectFacts } from '../src/index.js'
import { kitServiceContext } from './kit-fixture.js'

it.each(['vite-refine', 'next-refine'] as const)(
  'FR-RC-02: %s row actions refetch the current table query after a successful mutation', async (target) => {
    const blueprint = loadBlueprint({ [pageDocPath('CustomerList')]: JSON.stringify({
      $schema: SCHEMA_URL.page, blueprintVersion: 1, id: 'pg_00000000000000000000000004',
      name: 'CustomerList', route: '/customers', kind: 'list', resource: 'Customer',
      options: {
        rowActions: [{ name: 'approve', label: 'Approve', steps: [
          { do: 'mutate', resource: 'Customer', operation: 'update', id: 'row.id', input: '{}' },
          { do: 'refetch', query: 'list' },
        ] }],
        headerActions: [{ name: 'refresh', label: 'Refresh', steps: [{ do: 'refetch', query: 'list' }] }],
      },
    }) })
    const context = await kitServiceContext(new URL('../../../examples/refine-admin/', import.meta.url))
    // Exercise lowering directly. The dev service's validation is tested separately.
    delete context.validation
    const facts = { ...context.facts, target, pagesDir: projectFacts({ target }).pagesDir }
    const page = compilePage(blueprint, 'CustomerList', { ...context, facts })
    const { code, file } = target === 'next-refine' ? page.additional![0]! : page

    const refetch = vi.fn(async () => {})
    const mutateAsync = vi.fn(async () => {})
    const useTable = vi.fn(() => ({ refineCore: { tableQuery: { refetch } } }))
    const exports: Record<string, () => unknown> = {}
    const effects: Array<() => void> = []
    const callbacks: Array<(event: unknown, row: { id: string }) => Promise<void>> = []
    const modules = {
      react: {
        useMemo: (factory: () => unknown) => factory(),
        useCallback: (callback: typeof callbacks[number]) => {
          callbacks.push(callback)
          return callback
        },
        useRef: (current: unknown) => ({ current }),
        useLayoutEffect: (effect: () => void) => effects.push(effect),
      },
      'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
      '@refinedev/core': { useUpdate: () => ({ mutateAsync }) },
      '@refinedev/react-table': { useTable },
    }
    runInNewContext(ts.transpileModule(code, {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, { exports, require: (name: keyof typeof modules) => modules[name] ?? {} })
    exports['CustomerList']!()
    for (const effect of effects) effect()
    expect(useTable).toHaveBeenCalledTimes(1)
    expect(code).toContain('await table.refineCore.tableQuery.refetch()')
    expect(callbacks).toHaveLength(1)
    const [approve] = callbacks

    let finishMutation!: () => void
    const mutation = new Promise<void>((resolve) => { finishMutation = resolve })
    mutateAsync.mockReturnValueOnce(mutation)
    const pending = approve!({}, { id: 'customer-1' })
    expect(mutateAsync).toHaveBeenCalledWith({ resource: 'customers', id: 'customer-1', values: {} })
    expect(refetch).not.toHaveBeenCalled()
    finishMutation()
    await pending
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(refetch).toHaveBeenCalledWith({ throwOnError: true })

    const error = new Error('mutation failed')
    mutateAsync.mockRejectedValueOnce(error)
    await expect(approve!({}, { id: 'customer-1' })).rejects.toBe(error)
    expect(refetch).toHaveBeenCalledTimes(1)
  },
)
