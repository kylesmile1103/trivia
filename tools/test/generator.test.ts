import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { readJson, updateJson, writeJson, type Tree } from '@nx/devkit'
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing'
import { beforeEach, describe, expect, it } from 'vitest'

const generator = createRequire(import.meta.url)('../generators/package/index.cjs')
const repo = path.resolve(import.meta.dirname, '../..')
const templates = path.resolve(import.meta.dirname, '../generators/package/files')

describe('nx g @trivia/tools:package', () => {
  let tree: Tree

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace()
    tree.write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n')
    writeJson(tree, 'packages/contract-sync/package.json', {
      name: '@trivia/contract-sync',
      version: '1.2.3',
      devDependencies: { '@types/node': '^24.0.0', typescript: '~6.0.2', vitest: '^5.0.3' },
      nx: { name: 'contract-sync' },
    })
    updateJson(tree, 'nx.json', (nx) => ({ ...nx, release: { projects: ['contract-sync'] } }))
  })

  it('writes a package set up like contract-sync, at the release version, and releases it', async () => {
    await generator(tree, { name: 'widgets', description: 'Widgets & "gadgets" <for> agents' })

    const manifest = readJson(tree, 'packages/widgets/package.json')
    expect(manifest).toMatchObject({
      name: '@trivia/widgets',
      version: '1.2.3',
      private: true,
      description: 'Widgets & "gadgets" <for> agents',
      scripts: { build: 'tsc -p tsconfig.build.json', typecheck: 'tsc -p tsconfig.json --noEmit', test: 'vitest run' },
      devDependencies: { '@types/node': '^24.0.0', typescript: '~6.0.2', vitest: '^5.0.3' },
      nx: { name: 'widgets' },
    })
    expect(tree.read('packages/widgets/README.md', 'utf-8')).toBe('# @trivia/widgets\n\nWidgets & "gadgets" <for> agents\n')
    expect(tree.read('packages/widgets/src/index.ts', 'utf-8')).toContain("export const packageName = '@trivia/widgets'")
    expect(tree.exists('packages/widgets/test/index.test.ts')).toBe(true)
    expect(tree.exists('packages/widgets/vitest.config.ts')).toBe(true)
    expect(readJson(tree, 'nx.json').release.projects).toEqual(['contract-sync', 'widgets'])
  })

  it('refuses a name that is not kebab-case, or one already taken', async () => {
    await expect(generator(tree, { name: 'Widgets' })).rejects.toThrow(/not a kebab-case name/)
    await expect(generator(tree, { name: 'contract-sync' })).rejects.toThrow(/already exists/)
  })

  it("adds the project to nx.json's release in place: one line changes", () => {
    const before = fs.readFileSync(path.join(repo, 'nx.json'), 'utf8')
    const after = generator.addReleaseProject(before, 'widgets')
    const changed = after.split('\n').filter((line: string, i: number) => line !== before.split('\n')[i])
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatch(/"projects": \[.*"shell", "widgets"\],$/)
  })

  it('keeps a one-per-line array one per line, and fills an empty one', () => {
    const multiline = '{\n  "release": {\n    "projects": [\n      "a",\n      "b"\n    ]\n  }\n}\n'
    expect(generator.addReleaseProject(multiline, 'c')).toBe(multiline.replace('"b"', '"b",\n      "c"'))
    expect(generator.addReleaseProject('{ "release": { "projects": [] } }', 'c')).toBe('{ "release": { "projects": ["c"] } }')
  })

  it("keeps the templates' tsconfig files identical to contract-sync's", () => {
    for (const file of ['tsconfig.json', 'tsconfig.build.json']) {
      expect(fs.readFileSync(path.join(templates, `${file}__tmpl__`), 'utf8')).toBe(
        fs.readFileSync(path.join(repo, 'packages/contract-sync', file), 'utf8'),
      )
    }
  })
})
