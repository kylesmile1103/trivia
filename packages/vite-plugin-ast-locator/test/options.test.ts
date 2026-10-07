import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Alias } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveProjectPaths } from '../src/options.js'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-options-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function project(components: unknown, dirs: string[] = []): void {
  if (components !== undefined) {
    const text = typeof components === 'string' ? components : JSON.stringify(components)
    fs.writeFileSync(path.join(root, 'components.json'), text)
  }
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true })
}

describe('resolveProjectPaths', () => {
  it('maps components.json aliases.ui through a string alias', () => {
    project({ aliases: { ui: '@/components/ui' } }, ['src/components/ui'])
    const aliases: Alias[] = [{ find: '@', replacement: path.join(root, 'src') }]
    expect(resolveProjectPaths(root, aliases, {})).toEqual({
      uiDir: 'src/components/ui',
      importBase: '@/components/ui',
      warnings: [],
    })
  })

  it('maps through a regex alias and honours alias order', () => {
    project({ aliases: { ui: '~/ui' } }, ['app/ui'])
    const aliases: Alias[] = [
      { find: /^\/?@vite\/client/, replacement: '/nowhere' },
      { find: /^~\//, replacement: `${path.join(root, 'app')}/` },
      { find: '~', replacement: path.join(root, 'wrong') },
    ]
    expect(resolveProjectPaths(root, aliases, {})).toMatchObject({ uiDir: 'app/ui', importBase: '~/ui', warnings: [] })
  })

  it('does not treat "@" as a prefix of "@scope/…"', () => {
    project({ aliases: { ui: '@acme/ui' } })
    const aliases: Alias[] = [{ find: '@', replacement: path.join(root, 'src') }]
    const paths = resolveProjectPaths(root, aliases, {})
    expect(paths.uiDir).toBe('src/components/ui')
    expect(paths.importBase).toBe('@acme/ui')
    expect(paths.warnings[0]).toContain('cannot map components.json aliases.ui "@acme/ui"')
  })

  it('falls back to the shadcn convention (@/ → src/) without a bundler alias', () => {
    project({ aliases: { ui: '@/components/ui' } }, ['src/components/ui'])
    expect(resolveProjectPaths(root, [], {})).toMatchObject({ uiDir: 'src/components/ui', warnings: [] })
  })

  it('derives ui from aliases.components like shadcn does', () => {
    project({ aliases: { components: '@/widgets' } }, ['src/widgets/ui'])
    expect(resolveProjectPaths(root, [], {})).toMatchObject({ uiDir: 'src/widgets/ui', importBase: '@/widgets/ui' })
  })

  it('uses defaults without components.json, and says when the directory is missing', () => {
    const paths = resolveProjectPaths(root, [], {})
    expect(paths.uiDir).toBe('src/components/ui')
    expect(paths.importBase).toBe('@/components/ui')
    expect(paths.warnings).toEqual([
      'component library directory src/components/ui does not exist; /@trivia/api/components will fail until it does',
    ])
  })

  it('warns about an unreadable components.json instead of guessing silently', () => {
    project('{ not json', ['src/components/ui'])
    const paths = resolveProjectPaths(root, [], {})
    expect(paths.uiDir).toBe('src/components/ui')
    expect(paths.warnings[0]).toMatch(/^ignoring components\.json: /)
  })

  it('lets explicit options win and normalises them', () => {
    project({ aliases: { ui: '@/components/ui' } }, ['lib/ui'])
    expect(resolveProjectPaths(root, [], { uiDir: './lib/ui/', importBase: '#ui' })).toEqual({
      uiDir: 'lib/ui',
      importBase: '#ui',
      warnings: [],
    })
  })

  it('flags a library outside the project root', () => {
    const paths = resolveProjectPaths(root, [], { uiDir: '../elsewhere' })
    expect(paths.uiDir).toBe('../elsewhere')
    expect(paths.warnings[0]).toContain('outside the project root')
  })
})
