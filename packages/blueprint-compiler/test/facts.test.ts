import { expect, it } from 'vitest'

import { projectFacts, type PageIR } from '../src/index.js'

it('derives project facts from caller-provided data', () => {
  const installed = new Set(['input', 'button'])
  const facts = projectFacts({
    aliases: { components: '#/components/' },
    pagesDir: 'src/screens/',
    entrySource: "import {\n  App\n} from './App'\nimport './index.css'\n",
    formStyle: 'FormField',
    installed,
  })
  installed.clear()
  expect(facts).toEqual({
    target: 'vite-refine', aliases: { components: '#/components', ui: '#/components/ui' },
    pagesDir: 'src/screens', style: { semicolons: false, quotes: 'single' }, formStyle: 'FormField',
    installed: new Set(['button', 'input']),
  })
})

it('provides stable defaults for an app with no style evidence', () => {
  const facts = projectFacts()
  expect(facts).toMatchObject({
    pagesDir: 'src/pages', style: { semicolons: true, quotes: 'double' }, formStyle: 'Field',
  })
  const ir: PageIR = {
    name: 'Dashboard', file: `${facts.pagesDir}/Dashboard/Dashboard.tsx`, route: '/dashboard',
    client: false, imports: [], state: [], queries: [], mutations: [], hooks: [], handlers: [],
    jsx: { kind: 'element', tag: 'main', props: [], children: [] },
  }
  expect(ir.jsx).toMatchObject({ tag: 'main' })
})
