import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { EngineService, loadEngine } from '@trivia/dev-service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createNextHost } from '../src/host.js'

let root: string
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trivia-next-routes-'))) })
afterEach(async () => fs.rm(root, { recursive: true, force: true }))

async function write(file: string, text = 'export default function Page() { return <main /> }\n') {
  const absolute = path.join(root, file)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, text)
}

describe('FR-TN-04: App Router routes', () => {
  it('lists App Router pages and Refine labels beyond src, omitting non-page trees', async () => {
    const pages = [
      'app/page.tsx',
      'app/(bank)/customers/page.tsx',
      'app/(bank)/customers/edit/[id]/page.jsx',
      'app/help/[...slug]/page.tsx',
      'app/docs/[[...slug]]/page.tsx',
      'app/%5Fpublic/page.tsx',
      'app/(bank)/@modal/overlay/page.tsx',
      'app/(bank)/(.)intercept/page.tsx',
      'app/(bank)/(..)(..)nested/page.tsx',
      'app/(bank)/_internal/page.tsx',
      'app/(blueprint-preview)/%5F_blueprint/preview/page.tsx',
      'app/api/route.ts',
      'app/ignored/layout.tsx',
      'src/app/wrong-root/page.tsx',
    ]
    await Promise.all(pages.map((file) => write(file)))
    await write('providers/deep/bank/shell.tsx', `
      export const Shell = () => (
        <Refine resources={[{ name: "customers", list: "/customers", edit: "/customers/edit/:id" }]} />
      )
    `)
    const engine = await loadEngine()
    const service = new EngineService({ host: createNextHost(root, engine), engine, version: 'test' })
    const routes = await service.routes()
    expect(routes.map((r) => [r.path, r.file, r.params, r.resource])).toEqual([
      ['/', pages[0], [], null],
      ['/_public', pages[5], [], null],
      ['/customers', pages[1], [], { name: 'customers', action: 'list' }],
      ['/customers/edit/:id', pages[2], ['id'], { name: 'customers', action: 'edit' }],
      ['/docs/*', pages[4], ['*'], null],
      ['/help/*', pages[3], ['*'], null],
    ])
    expect(routes[0]).toMatchObject({ router: 'next-app-router', index: true, declared: { file: pages[0], line: 1 }, locator: null })
    expect(routes.filter((r) => r.catchAll).map((r) => r.path)).toEqual(['/docs/*', '/help/*'])
  })

  it('supports the src/app placement', async () => {
    await write('src/app/status/page.jsx')
    const engine = await loadEngine()
    const host = createNextHost(root, engine)
    const service = new EngineService({ host, engine, version: 'test' })
    expect(await service.routes()).toMatchObject([{ path: '/status', file: 'src/app/status/page.jsx', params: [] }])
  })

  it('undo releases generated route directories while preserving pre-existing directories', async () => {
    await write('app/page.tsx')
    await fs.mkdir(path.join(root, 'app/existing'))
    const engine = await loadEngine()
    const service = new EngineService({ host: createNextHost(root, engine), engine, version: 'test' })
    const content = 'export default function Page() { return <main /> }\n'
    await service.batch(['app/new/page.tsx', 'app/existing/page.tsx'].map((file) => ({ op: 'createFile', file, content })))
    await service.undo()
    expect(await fs.readdir(path.join(root, 'app'))).toEqual(['existing', 'page.tsx'])
    expect(await fs.readdir(path.join(root, 'app/existing'))).toEqual([])
  })
})
