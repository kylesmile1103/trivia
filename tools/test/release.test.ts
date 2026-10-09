import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { commitType, unknownCommitTypes } from '../release/preflight.mjs'

const require = createRequire(import.meta.url)
const { canonicalTypes } = require('../release/changelog-renderer.cjs')
const nxJson = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../nx.json'), 'utf8'))
const declared: Record<string, unknown> = nxJson.release.conventionalCommits.types

describe('commit types', () => {
  it('reads the prefix the way Nx does', () => {
    expect(commitType('engine: setText op (ops/set_text.rs)')).toBe('engine')
    expect(commitType('e2e(style): fail on any page or console error')).toBe('e2e')
    expect(commitType('engine + MCP: file outline')).toBe('__INVALID__')
    expect(commitType('Desktop shell (Tauri), and screenshots')).toBe('__INVALID__')
  })

  it('lists the subjects whose prefix nx.json does not declare', () => {
    const known = new Set(Object.keys(declared))
    const unknown = unknownCommitTypes(['engine: a', 'inspector: b', 'inspector: c', 'no prefix here'], known)
    expect([...unknown]).toEqual([['inspector', ['inspector: b', 'inspector: c']]])
  })

  it('declares every area prefix used since the scaffold', () => {
    for (const type of ['engine', 'plugin', 'Plugin', 'MCP', 'designer', 'docs', 'contract-sync', 'shell', 'repo']) {
      expect(declared).toHaveProperty([type])
    }
  })
})

describe('changelog sections', () => {
  it('folds types with one title into the first declared', () => {
    const canonical = canonicalTypes({
      plugin: { changelog: { title: 'Plugin' } },
      mcp: { changelog: { title: 'MCP' } },
      Plugin: { changelog: { title: 'Plugin' } },
      MCP: { changelog: { title: 'MCP' } },
    })
    expect(canonical).toEqual({ plugin: 'plugin', mcp: 'mcp', Plugin: 'plugin', MCP: 'mcp' })
  })
})
