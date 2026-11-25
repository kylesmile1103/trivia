import fs from 'node:fs'
import path from 'node:path'

import { emptyLock, prepareEject } from '@trivia/blueprint-compiler'
import { expect, it } from 'vitest'

import { EngineService, createStandaloneHost, loadEngine } from '../src/index.js'
import { copyBlueprintProject } from './blueprint-fixture.js'

it('FR-RC-07 uses shared registration ops for several contract pages and a custom route', async () => {
  const root = copyBlueprintProject()
  try {
    const service = new EngineService({ host: createStandaloneHost(root), engine: await loadEngine(), version: 'test' })
    const drafts = [
      { name: 'AccountCreate', kind: 'create', resource: 'Account', route: '/ledger/new' },
      { name: 'AccountShow', kind: 'show', resource: 'Account', route: '/ledger/:id' },
      { name: 'Overview', kind: 'custom', route: '/overview' },
    ]
    await service.patchBlueprint(drafts.map((draft) => ({
      op: 'createPage', doc: 'pages/' + draft.name + '.page.json', baseRev: null, ...draft,
    })), 'Drafts')
    const { blueprint, context } = await service.blueprintInputs()
    const candidates = prepareEject(blueprint, undefined, context, emptyLock())
    const app = fs.readFileSync(path.join(root, 'src/App.tsx'))
    const ops = await service.refine.planBlueprintRegistrations(candidates, context.contract ?? null)
    expect(ops).toEqual([
      expect.objectContaining({ op: 'setProperty', prop: 'create', value: '"/ledger/new"' }),
      expect.objectContaining({ op: 'setProperty', prop: 'show', value: '"/ledger/:id"' }),
      expect.objectContaining({ op: 'insert', expectedName: 'Route', snippet: expect.stringContaining('path="/ledger/new"') }),
      expect.objectContaining({ op: 'insert', expectedName: 'Route', snippet: expect.stringContaining('path="/ledger/:id"') }),
      expect.objectContaining({ op: 'insert', expectedName: 'Route', snippet: expect.stringContaining('path="/overview"') }),
    ])
    await service.batch([...candidates.map(({ module }) => ({ op: 'createFile', file: module.file, content: module.code })), ...ops], 'Register pages')
    expect(await service.routes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/ledger/new', resource: { name: 'accounts', action: 'create' } }),
      expect.objectContaining({ path: '/ledger/:id', resource: { name: 'accounts', action: 'show' } }),
      expect.objectContaining({ path: '/overview', resource: null }),
    ]))
    await service.undo()
    expect(fs.readFileSync(path.join(root, 'src/App.tsx'))).toEqual(app)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
