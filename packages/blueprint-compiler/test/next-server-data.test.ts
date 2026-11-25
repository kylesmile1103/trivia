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

it('FR-NX-05 keeps private queries uncached and emits an anonymous 30-second cache only for public data', async () => {
  const docs = fixture()
  const doc = pageDocPath('KitTable')
  const source = JSON.parse(docs[doc]!)
  source.route = '/people/:id'
  for (const id of Object.keys(source.nodes)) if (id !== source.root && id !== label) delete source.nodes[id]
  delete source.props
  source.queries = { customer: { kind: 'one', resource: 'Customer', params: { id: 'params.id' } } }
  source.bindings = { [label]: { children: 'data.customer.record?.fullName' } }
  docs['app.blueprint.json'] = docs['app.blueprint.json']!.replace('vite-refine', 'next-refine')
  const context = await kitServiceContext()
  const facts = { ...context.facts, target: 'next-refine', pagesDir: projectFacts({ target: 'next-refine' }).pagesDir } as const
  docs[doc] = JSON.stringify(source)
  const privateView = compilePage(loadBlueprint(docs), 'KitTable', { ...context, facts })
  expect(privateView.code).toContain('await apiRequest()')
  expect(privateView.code).not.toContain('unstable_cache')
  source.public = true
  docs[doc] = JSON.stringify(source)
  const publicView = compilePage(loadBlueprint(docs), 'KitTable', { ...context, facts })
  expect(publicView.code).toContain('unstable_cache')
  expect(publicView.code).toContain('revalidate: 30')
  expect(publicView.code).toContain('publicApiRequest()')
  expect(publicView.code).not.toContain('await apiRequest()')
  for (const [file, output] of [['private.tsx', privateView], ['public.tsx', publicView]] as const) {
    const golden = new URL('../fixtures/next/caching/' + file, import.meta.url)
    expect(output.code).toBe(readFileSync(golden, 'utf8'))
  }

  source.queries.customer.params.id = 'user.id'
  docs[doc] = JSON.stringify(source)
  expect(() => compilePage(loadBlueprint(docs), 'KitTable', { ...context, facts })).toThrow(expect.objectContaining({
    details: { diagnostics: expect.arrayContaining([expect.objectContaining({
      code: 'public_page_uses_user', doc, pointer: '/queries/customer/params/id',
    })]) },
  }))
  docs['app.blueprint.json'] = docs['app.blueprint.json']!.replace('next-refine', 'vite-refine')
  expect(() => compilePage(loadBlueprint(docs), 'KitTable', context)).not.toThrow()
})
