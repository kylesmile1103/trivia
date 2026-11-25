import { readFileSync } from 'node:fs'

import { loadBlueprint, pageDocPath } from '@trivia/blueprint'
import { expect, it } from 'vitest'

import { compilePage, projectFacts } from '../src/index.js'
import { fixture, kitServiceContext } from './kit-fixture.js'

const label = 'n_00000000000000000000000002'

it('FR-NX-03 fetches a route-dependent SDK query in the server page', async () => {
  const files = fixture()
  const doc = pageDocPath('KitTable')
  const source = JSON.parse(files[doc]!)
  source.route = '/people/:id'
  for (const id of Object.keys(source.nodes)) if (id !== source.root && id !== label) delete source.nodes[id]
  delete source.props
  source.queries = { customer: { kind: 'one', resource: 'Customer', params: { id: 'params.id' } } }
  source.bindings = { [label]: { children: 'data.customer.record?.fullName ?? "Missing name"' } }
  files[doc] = JSON.stringify(source)
  const blueprint = loadBlueprint(files)
  const context = await kitServiceContext()
  const facts = { ...context.facts, target: 'next-refine', pagesDir: projectFacts({ target: 'next-refine' }).pagesDir } as const
  const result = compilePage(blueprint, 'KitTable', { ...context, facts })
  expect(result.file).toBe('app/(app)/people/[id]/page.tsx')
  expect(result.additional).toBeUndefined()
  expect(result.code).toContain('await params')
  expect(result.code).toMatch(/await \w+\(.*id: __bpParams.id/)
  expect(result.code).toContain('fullName')
  expect(result.code).not.toContain('useOne')
  expect(compilePage(blueprint, 'KitTable', context).code).toContain('useOne')
})

it('FR-NX-04 forwards only the request credentials and lets Next handle 404s', () => {
  const helper = readFileSync(new URL('../templates/next-refine/src/server/api.ts', import.meta.url), 'utf8')
  expect(helper).toContain('await headers()')
  expect(helper).toContain("['cookie', 'authorization']")
  expect(helper).toContain('notFound()')
  expect(helper).toContain('throw new Error(')
})
