import fs from 'node:fs'

import type { TriviaManifest } from '@trivia/contract-sync'
import { expect, it } from 'vitest'

import { generateRefinePage } from '../src/index.js'

it('generates a Refine page from a contract resource and project facts alone', () => {
  const manifest: TriviaManifest = JSON.parse(fs.readFileSync(
    new URL('../../../examples/refine-admin/trivia.manifest.json', import.meta.url), 'utf8',
  ))
  const resource = manifest.resources.find(({ name }) => name === 'Account')!
  const output = generateRefinePage({
    resource,
    kind: 'create',
    project: {
      ui: '#/ui',
      refineUi: '#/refine-ui',
      typesImport: '#/api/generated/types.gen',
      pagesDir: 'src/screens',
      pagesImport: '#/screens',
    },
    options: { hideFields: ['currency'], title: 'New account' },
  })
  expect(output).toMatchObject({
    file: 'src/screens/accounts/create.tsx',
    component: 'AccountCreate',
    importPath: '#/screens/accounts/create',
    route: '/accounts/create',
  })
  expect(output.content).toContain('from "#/ui/button"')
  expect(output.content).toContain('<CreateViewHeader title="New account" />')
  expect(output.content).not.toContain('name="currency"')
})
