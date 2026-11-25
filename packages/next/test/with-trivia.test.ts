import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { withTrivia } from '../src/with-trivia.js'

let root: string
const context = { defaultConfig: {} }
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-config-'))) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('FR-TN-01 and FR-TN-06: withTrivia', () => {
  it('adds a development rule per JSX suffix while preserving the user’s rules', async () => {
    const webpack = vi.fn((config) => ({ ...config, userConfigured: true }))
    const input: NextConfig = { webpack, turbopack: { rules: { '*.tsx': ['earlier'], '*.svg': ['existing'] } } }
    const result = await withTrivia(input, { root })(PHASE_DEVELOPMENT_SERVER, context)
    const rules = result.turbopack?.rules
    const rule = expect.objectContaining({ condition: expect.any(Object), loaders: [{ loader: expect.stringMatching(/loader\.cjs$/), options: { root } }] })
    expect(rules).toMatchObject({ '*.tsx': ['earlier', rule], '*.jsx': [rule], '*.svg': ['existing'] })
    expect(input.turbopack?.rules).toEqual({ '*.tsx': ['earlier'], '*.svg': ['existing'] })

    const configured = result.webpack!({ module: { rules: [] } }, { dev: true } as Parameters<NonNullable<NextConfig['webpack']>>[1])
    const [loader] = configured.module.rules
    expect(configured.userConfigured).toBe(true)
    expect(webpack).toHaveBeenCalledOnce()
    expect(loader.enforce).toBe('pre')
    expect(loader.test.test('main.jsx')).toBe(true)
    for (const [file, includes] of [
      ['app/page.tsx', true],
      ['src/button.jsx', true],
      ['node_modules/dep/index.jsx', false],
      ['app/(blueprint-preview)/%5F_blueprint/example/page.tsx', false],
      ['src/app/(blueprint-preview)/%5F_blueprint/example/page.tsx', false],
      ['../other.tsx', false],
    ] as const) expect(loader.include(path.resolve(root, file)), file).toBe(includes)
  })

  it('preserves production config, including async user factories', async () => {
    const input: NextConfig = { basePath: '/admin' }
    const wrapped = withTrivia(async () => input, { root })
    expect(await wrapped(PHASE_PRODUCTION_BUILD, context)).toBe(input)
    expect(await wrapped(PHASE_PRODUCTION_SERVER, context)).toBe(input)
  })

  it('refuses a production build with an App Router preview directory', async () => {
    const preview = path.join(root, 'src/app/(blueprint-preview)')
    fs.mkdirSync(preview, { recursive: true })
    const wrapped = withTrivia({}, { root })
    await expect(wrapped(PHASE_PRODUCTION_BUILD, context)).rejects.toThrow(/delete .*\(blueprint-preview\)/i)
    await expect(wrapped(PHASE_DEVELOPMENT_SERVER, context)).resolves.toHaveProperty('turbopack')
  })
})
