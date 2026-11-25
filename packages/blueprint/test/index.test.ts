import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import * as blueprint from '../src/index.js'
import { FIXTURES, readFixture } from './helpers.js'

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

  it('resolves the sample component manifests through its entry point alone', () => {
    const kit = Object.values(readFixture(path.join(FIXTURES, 'manifests/kit-sample')))
      .map((text) => blueprint.componentManifestSchema.parse(JSON.parse(text)))
    const components: blueprint.ComponentSchema[] = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, 'manifests/analyzer/refine-admin.components.json'), 'utf8'),
    )
    const { manifests } = blueprint.resolveManifests({ kit, components })
    expect(manifests).toMatchObject({
      Button: { installed: true, source: { import: { from: '@/components/ui/button' } } },
      Card: { installed: false },
      Input: { installed: true, exposes: [{ name: 'value', type: 'string' }] },
    })
  })
})
