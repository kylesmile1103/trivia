import fs from 'node:fs'
import path from 'node:path'

import { loadBlueprint, SCHEMA_URL } from '@trivia/blueprint'
import { compilePage, projectFacts, type CompileContext } from '@trivia/blueprint-compiler'
import { generateRefinePage, loadEngine } from '@trivia/dev-service'
import { expect, it } from 'vitest'

import { copyRefineAdmin, post, startServer } from './helpers.js'

it('FR-RC-02: compiles all four default pages byte for byte as refine/pages/plan', async () => {
  const root = copyRefineAdmin()
  try {
    const app = path.join(root, 'src/App.tsx')
    fs.writeFileSync(app, fs.readFileSync(app, 'utf8')
      .replace(/^.*AccountList.*\n/gm, '')
      .replace(/^.*list: "\/accounts",\n/m, ''))
    fs.rmSync(path.join(root, 'src/pages/accounts/list.tsx'))
    const server = await startServer(root)
    try {
      const contract: NonNullable<CompileContext['contract']> = JSON.parse(fs.readFileSync(path.join(root, 'trivia.manifest.json'), 'utf8'))
      const typesImport = contract.modules.types?.importPath
      if (!typesImport) throw new Error('Fixture contract must have generated types')
      const context: CompileContext = {
        contract, engine: await loadEngine(), facts: projectFacts(),
        generateContractPage: (input) => generateRefinePage({
          ...input,
          project: {
            ui: '@/components/ui', refineUi: '@/components/refine-ui', textarea: true,
            pagesDir: 'src/pages', pagesImport: '@/pages', typesImport,
          },
        }),
      }
      const kinds = ['list', 'create', 'edit', 'show'] as const
      const plan = await post(server.socket, '/refine/pages/plan', { resource: 'Account', pages: kinds })
      expect(plan.status, JSON.stringify(plan.body)).toBe(200)
      const blueprint = loadBlueprint(Object.fromEntries(kinds.map((kind, i) => {
        const name = 'Account' + kind[0]!.toUpperCase() + kind.slice(1)
        const route = kind === 'list' ? '/accounts' : '/accounts/' + kind + (kind === 'create' ? '' : '/:id')
        return ['pages/' + name + '.page.json', JSON.stringify({
          $schema: SCHEMA_URL.page, blueprintVersion: 1, name, route, kind, resource: 'Account',
          id: 'pg_0000000000000000000000000' + i,
        })]
      })))
      for (const kind of kinds) {
        const name = 'Account' + kind[0]!.toUpperCase() + kind.slice(1)
        const op = plan.body.data.ops.find((op: { file?: string }) => op.file === 'src/pages/accounts/' + kind + '.tsx')
        expect(compilePage(blueprint, name, context)).toMatchObject({ file: op.file, code: op.content })
      }
    } finally {
      await server.close()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
