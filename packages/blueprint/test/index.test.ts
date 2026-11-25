import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import * as blueprint from '../src/index.js'
import { FIXTURES } from './helpers.js'

describe('@trivia/blueprint', () => {
  it('is the package the workspace knows', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'))
    expect(manifest.name).toBe('@trivia/blueprint')
  })

  it('reads, patches and projects a blueprint through its entry point alone', async () => {
    const store = blueprint.createStore({ dir: path.join(FIXTURES, 'valid/backoffice'), ids: blueprint.sequenceSource() })
    const bp = await store.read()
    expect(blueprint.validate(bp)).toEqual([])
    const doc = blueprint.pageDocPath('CustomerList')
    const outcome = await store.apply([{ op: 'setPageMeta', doc, baseRev: bp.docs[doc]?.rev ?? null, public: true }])
    expect(outcome.ok && outcome.writes.map((w) => w.file)).toEqual([doc])
    const page = bp.docs[blueprint.pageDocPath('CustomerOverview')]?.doc
    expect(page && blueprint.project(page as blueprint.PageDoc)).toContain('<Card name="summary"')
  })
})
