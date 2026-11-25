import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadBlueprint, type Blueprint } from '@trivia/blueprint'
import { expect, it } from 'vitest'

import { compilePage, projectFacts, type CompileContext } from '../src/index.js'
import { fixture, kitServiceContext } from './kit-fixture.js'
import { dotnetAvailable, mvpContract, prepareMvp, serviceContext } from './next-fixture.js'

function compileBoth(blueprint: Blueprint, context: CompileContext, count: number) {
  const entries = Object.values(blueprint.docs).flatMap((entry) => entry.kind === 'page' && entry.doc ? [entry.doc] : [])
  expect(entries).toHaveLength(count)
  for (const target of ['vite-refine', 'next-refine'] as const) {
    const facts = { ...context.facts, target, pagesDir: projectFacts({ target }).pagesDir }
    for (const { name, route } of entries) {
      const result = compilePage(blueprint, name, { ...context, facts })
      expect(result.route).toBe(route)
      expect(result.file).toMatch(target === 'vite-refine' ? /^src\/pages\// : /^app\/\(app\)\/.+\/page\.tsx$/)
      for (const { code } of [result, ...(result.additional ?? [])]) {
        expect(code).not.toMatch(/from ['"]@trivia\//)
      }
    }
  }
}

it('SC-001 compiles every kit page for both targets from the same documents', async () => {
  compileBoth(loadBlueprint(fixture()), await kitServiceContext(), 6)
})

it.skipIf(!dotnetAvailable)('SC-001 compiles every MVP page for both targets from the same documents (requires .NET SDK)', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-next-dual-')))
  try {
    const web = prepareMvp(root)
    await mvpContract(root, web)
    const { blueprint, context } = await serviceContext(web)
    compileBoth(blueprint, context, 5)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 180_000)
