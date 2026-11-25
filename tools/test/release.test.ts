import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { checkMvpBeforeRelease, commitType, unknownCommitTypes } from '../release/preflight.mjs'

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

  it('declares the areas of the blueprint track (specs/001-blueprint-schema T002)', () => {
    for (const type of ['blueprint', 'compiler', 'dotnet']) {
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

describe('the release MVP check', () => {
  const root = path.resolve('checkout')

  it.each(['The MVP slice needs the .NET 10 SDK.', 'The MVP slice needs a running container runtime.'])(
    'refuses to continue when %s', (message) => {
      const run = vi.fn()
      expect(() => checkMvpBeforeRelease(root, {}, () => message, run)).toThrow(message)
      expect(run).not.toHaveBeenCalled()
    },
  )

  it('requires the scripted slice to run to completion under Nx', () => {
    const run = vi.fn().mockReturnValue({ status: 0 })
    checkMvpBeforeRelease(root, { PATH: 'test-path' }, () => undefined, run)
    expect(run).toHaveBeenCalledWith(path.join(root, 'node_modules', '.bin', 'nx'), ['run', 'tools:mvp'], {
      cwd: root, env: { PATH: 'test-path', TRIVIA_MVP_REQUIRED: '1' }, stdio: 'inherit',
    })
    run.mockReturnValue({ status: 3 })
    expect(() => checkMvpBeforeRelease(root, {}, () => undefined, run)).toThrow('MVP acceptance failed (exit 3).')
  })
})
