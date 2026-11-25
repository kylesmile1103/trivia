import { expect, it } from 'vitest'

import { projectFacts, targetFor } from '../src/index.js'

it('SC-004 dispatches Vite files, route registration and preview through one target', () => {
  const facts = projectFacts()
  const target = targetFor(facts.target)
  const file = 'src/pages/Report/Report.tsx'
  const [output] = target.files({
    kind: 'custom',
    ir: {
      name: 'Report', file, route: '/report', client: false,
      imports: [], state: [], queries: [], mutations: [], hooks: [], handlers: [],
      jsx: { kind: 'element', tag: 'main', props: [], children: [] },
    },
    requires: [],
  }, facts)
  expect(output).toMatchObject({
    file, code: 'export function Report() {\n  return (\n    <main />\n  );\n}\n',
    importPath: './pages/Report/Report',
  })
  expect(target.routeOps([output], { parent: 'src/App.tsx#App#0', index: 1, placement: 'before' })).toEqual([{
    op: 'insert',
    target: 'src/App.tsx#App#0.1',
    expectedName: 'Route',
    placement: 'before',
    snippet: '<Route path="/report" element={<Report />} />',
    imports: [{ name: 'Report', source: './pages/Report/Report' }],
  }])
  expect(target.hooks.router).toEqual({ source: 'react-router', searchTuple: true })
  expect(target.preview('Report')).toMatchObject({ route: '/__blueprint/Report', id: /^blueprint-[a-f0-9]{16}$/ })
})
