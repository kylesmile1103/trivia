import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { CliIo } from '../src/cli.js'
import { main } from '../src/cli.js'
import type { TriviaManifest } from '../src/manifest/types.js'
import { fixture, listFiles, makeProject, removeProject } from './helpers.js'

/** The package's own version: a release bumps it, so tests read it rather than repeat it. */
const VERSION = (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

function capture(env: Record<string, string | undefined> = {}): CliIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, stdout: (text) => out.push(text), stderr: (text) => err.push(text), env }
}

describe('trivia-contract-sync CLI', () => {
  let root: string
  beforeAll(async () => {
    root = await makeProject()
    await fsp.mkdir(path.join(root, 'openapi'))
    await fsp.copyFile(fixture('customers.openapi.json'), path.join(root, 'openapi/customers.openapi.json'))
  })
  afterAll(async () => {
    await removeProject(root)
  })

  it('generates code and the manifest with the documented flags', async () => {
    const io = capture()
    const code = await main(
      ['--input', 'openapi/customers.openapi.json', '--output', 'src/api/generated', '--manifest', 'trivia.manifest.json', '--cwd', root],
      io,
    )
    expect(io.err.join('')).toBe('')
    expect(code).toBe(0)
    const text = io.out.join('')
    expect(text).toContain('Generated 17 files in src/api/generated with @hey-api/openapi-ts 0.99.0')
    expect(text).toContain('  Customer: list, get, create, update, delete; 1 custom\n')
    expect(text).toContain('  Health: no CRUD; 1 custom\n')
    const manifest = JSON.parse(await fsp.readFile(path.join(root, 'trivia.manifest.json'), 'utf8')) as TriviaManifest
    expect(manifest.resources.map((resource) => resource.name)).toEqual(['Customer', 'Health'])
    expect(await listFiles(path.join(root, 'src/api/generated'))).toContain('@tanstack/react-query.gen.ts')
  })

  it('honours --import-alias', async () => {
    const io = capture()
    const code = await main(
      ['--input', 'openapi/customers.openapi.json', '--output', 'app/api', '--manifest', 'alias.json', '--import-alias', '~/=app', '--cwd', root],
      io,
    )
    expect(code).toBe(0)
    const manifest = JSON.parse(await fsp.readFile(path.join(root, 'alias.json'), 'utf8')) as TriviaManifest
    expect(manifest.modules.queries.importPath).toBe('~/api/@tanstack/react-query.gen')
  })

  it('prints help and version', async () => {
    const help = capture()
    expect(await main(['--help'], help)).toBe(0)
    expect(help.out.join('')).toContain('Usage: trivia-contract-sync --input <path|url>')
    const version = capture()
    expect(await main(['-v'], version)).toBe(0)
    expect(version.out.join('')).toBe(`${VERSION}\n`)
  })

  it('exits 2 on usage errors', async () => {
    for (const argv of [
      [],
      ['--input', 'a.json', '--supabase-url', 'https://abc.supabase.co', '--supabase-key', 'k'],
      ['--supabase-url', 'https://abc.supabase.co'],
      ['--input', 'a.json', '--import-alias', 'nonsense'],
      ['--unknown-flag'],
    ]) {
      const io = capture()
      expect(await main(argv, io), argv.join(' ')).toBe(2)
      expect(io.err.join('')).toMatch(/^error/)
    }
  })

  it('exits 1 with the error code and hint on failures, writing nothing', async () => {
    const io = capture()
    const code = await main(['--input', 'openapi/missing.json', '--output', 'src/never', '--manifest', 'never.json', '--cwd', root], io)
    expect(code).toBe(1)
    expect(io.err.join('')).toMatch(/^error\[input_not_found\]: Spec file not found: .*openapi\/missing\.json\n$/)
    expect(fs.existsSync(path.join(root, 'src/never'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'never.json'))).toBe(false)
  })

  it('takes the Supabase key from TRIVIA_SUPABASE_KEY when --supabase-key is absent', async () => {
    // Port 9 (discard) on loopback refuses connections: proves the key was accepted and a
    // request was attempted, without touching the network.
    const io = capture({ TRIVIA_SUPABASE_KEY: 'sb_secret_from_env' })
    const code = await main(['--supabase-url', 'http://127.0.0.1:9', '--cwd', root], io)
    expect(code).toBe(1)
    expect(io.err.join('')).toMatch(/^error\[network_error\]: Could not reach Supabase at http:\/\/127\.0\.0\.1:9\/rest\/v1\//)
    expect(io.err.join('')).not.toContain('sb_secret_from_env')
  })
})
