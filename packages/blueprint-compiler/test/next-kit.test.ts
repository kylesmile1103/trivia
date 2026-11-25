import { readFileSync } from 'node:fs'

import { loadBlueprint } from '@trivia/blueprint'
import { expect, it } from 'vitest'

import { compilePage, projectFacts } from '../src/index.js'
import { fixture, kitServiceContext } from './kit-fixture.js'

it('FR-NX-02 preserves the split module goldens for the full kit', async () => {
  const blueprint = loadBlueprint(fixture())
  const before = await kitServiceContext()
  const target = 'next-refine'
  const facts = { ...before.facts, target, pagesDir: projectFacts({ target }).pagesDir } as const
  for (const entry of Object.values(blueprint.docs)) {
    if (entry.kind !== 'page' || !entry.doc) continue
    const output = compilePage(blueprint, entry.doc.name, { ...before, facts })
    for (const module of [output, ...(output.additional ?? [])]) {
      const golden = new URL('../fixtures/next/kit/' + module.file, import.meta.url)
      expect(module.code, module.file).toBe(readFileSync(golden, 'utf8'))
    }
  }
})
