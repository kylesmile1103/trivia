import { readFileSync } from 'node:fs'

import { loadBlueprint, pageDocPath } from '@trivia/blueprint'
import { expect, it } from 'vitest'

import { compilePage, projectFacts } from '../src/index.js'
import { kitServiceContext } from './kit-fixture.js'

it('FR-NX-01 and FR-NX-02 type a catch-all and pass its server expression into a client view', async () => {
  const name = 'RouteProbe'
  const input = readFileSync(new URL('../fixtures/next/edge/RouteProbe.page.json', import.meta.url), 'utf8')
  const blueprint = loadBlueprint({ [pageDocPath(name)]: input })
  const context = await kitServiceContext()
  const facts = { ...context.facts, target: 'next-refine', pagesDir: projectFacts({ target: 'next-refine' }).pagesDir } as const
  const next = compilePage(blueprint, name, { ...context, facts })
  expect(next.file).toBe('app/(app)/probe/[...splat]/page.tsx')
  expect(next.code).toContain('splat: string[]')
  expect(next.code).toContain('await params')
  expect(next.code).toContain('__bpParams.splat.join(')
  expect(next.additional).toHaveLength(1)
  expect(next.additional![0]!.code).toContain('{__bpValue1}')
  expect(next.additional![0]!.code).not.toContain('useParams')

  const vite = compilePage(blueprint, name, context)
  expect(vite.route).toBe('/probe/*')
  expect(vite.code).toMatch(/params\[['"]\*['"]\]\?\.split\(/)
})
