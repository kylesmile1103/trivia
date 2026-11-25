import { expect, it } from 'vitest'

import { targetFor } from '../src/index.js'

it('FR-NX-01 registers Next resources with value operations only', () => {
  const path = 'app/providers.tsx#Providers#<Refine>.resources'
  const result = targetFor('next-refine').routeOps({
    files: [{ route: '/customers', component: 'Page', importPath: './(app)/customers/page' }],
    resources: [
      { path, name: 'customers', routes: { list: '/customers', show: '/customers/show/:id' }, exists: false },
      { path, name: 'accounts', routes: { edit: '/accounts/:id/edit' }, exists: true },
    ],
  })
  expect(result).toEqual([
    { op: 'insertElement', path, value: '{\n  name: "customers",\n  list: "/customers",\n  show: "/customers/show/:id",\n}' },
    { op: 'setProperty', path: path + '[name=accounts]', prop: 'edit', value: '"/accounts/:id/edit"' },
  ])
})
