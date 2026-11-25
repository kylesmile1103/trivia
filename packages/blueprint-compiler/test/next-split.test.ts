import { loadBlueprint, pageDocPath, validate } from '@trivia/blueprint'
import { expect, it } from 'vitest'

import { compilePage, nextBoundaryCheck, projectFacts } from '../src/index.js'
import { fixture, kitServiceContext } from './kit-fixture.js'

it('FR-NX-02 leaves a static header in page.tsx when only the table needs the client', async () => {
  const documents = fixture()
  const doc = pageDocPath('KitTable')
  const input = JSON.parse(documents[doc]!)
  delete input.bindings
  documents[doc] = JSON.stringify(input)
  const context = await kitServiceContext()
  const result = compilePage(loadBlueprint(documents), 'KitTable', {
    ...context, facts: { ...context.facts, target: 'next-refine', pagesDir: projectFacts({ target: 'next-refine' }).pagesDir },
  })
  expect(result.code).toContain('<h1>Customer table</h1>')
  expect(result.code).toContain('<CustomersView />')
  expect(result.code).not.toContain('useTable')
  expect(result.additional).toHaveLength(1)
  expect(result.additional![0]!.code).toMatch(/['"]use client['"]/)
  expect(result.additional![0]!.code).toContain('useTable')
  expect(result.additional![0]!.code).not.toContain('<h1>Customer table</h1>')
})

it('FR-NX-02 names the node whose server function cannot cross a client boundary', async () => {
  const documents = fixture()
  const doc = pageDocPath('KitTable')
  const input = JSON.parse(documents[doc]!)
  input.bindings['n_00000000000000000000000003'] = { className: 'user.roles.map' }
  documents[doc] = JSON.stringify(input)
  const context = { next: nextBoundaryCheck(await kitServiceContext()) }
  expect(validate(loadBlueprint(documents), context)).toEqual([])
  documents['app.blueprint.json'] = documents['app.blueprint.json']!.replace('vite-refine', 'next-refine')
  expect(validate(loadBlueprint(documents), context)).toMatchObject([{
    doc,
    code: 'boundary_not_serializable',
    pointer: '/bindings/n_00000000000000000000000003/className',
    message: expect.stringContaining('customers'),
  }])
})
