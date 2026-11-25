import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import { compilePage } from '../src/index.js'
import { dotnetAvailable, mvp, mvpContract, prepareMvp, serviceContext } from './next-fixture.js'

it.skipIf(!dotnetAvailable)('FR-NX-01 emits the five MVP contract pages with a server entry and client view (requires .NET SDK)', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-next-contracts-')))
  try {
    const web = prepareMvp(root)
    await mvpContract(root, web)
    const { blueprint, context } = await serviceContext(web)
    const pages = Object.values(blueprint.docs).flatMap((entry) => entry.kind === 'page' && entry.doc ? [entry.doc] : [])
    expect(pages.map(({ name }) => name)).toEqual(['AccountList', 'CustomerCreate', 'CustomerEdit', 'CustomerList', 'CustomerShow'])
    for (const { name } of pages) {
      const output = compilePage(blueprint, name, context)
      expect(output.file).toMatch(/^app\/\(app\)\/.*\/page\.tsx$/)
      expect(output.code).toMatch(/from ['"]\.\/view['"]/)
      expect(output.code).not.toContain('use client')
      expect(output.additional).toHaveLength(1)
      const [view] = output.additional!
      expect(view!.file).toBe(path.posix.join(path.posix.dirname(output.file), 'view.tsx'))
      expect(view!.code).toMatch(/^['"]use client['"]/)
      for (const module of [output, view!]) {
        expect(module.code).toBe(fs.readFileSync(new URL('golden/' + module.file, mvp), 'utf8'))
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 180_000)

it.skipIf(!dotnetAvailable)('FR-NX-03 seeds the show and edit Refine queries from the server (requires .NET SDK)', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-next-seed-')))
  try {
    const web = prepareMvp(root)
    await mvpContract(root, web)
    const { blueprint, context } = await serviceContext(web)
    for (const name of ['CustomerShow', 'CustomerEdit']) {
      const output = compilePage(blueprint, name, context)
      expect(output.code).toContain('await params')
      expect(output.code).toContain('await apiRequest()')
      expect(output.code).toContain('initialRecord={initialRecord}')
      const [view] = output.additional!
      expect(view!.code).toContain('id: recordId')
      expect(view!.code).toContain('initialData: initialRecord')
      expect(view!.code).toContain('refetchOnMount: false')
    }
    expect(compilePage(blueprint, 'CustomerList', context).code).not.toContain('apiRequest')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 180_000)
