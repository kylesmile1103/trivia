import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ContractSyncError } from '../src/errors.js'
import { runContractSync } from '../src/codegen.js'
import type { HeyApiClientPlugin } from '../src/manifest-generator.js'
import type { SyncContractResult } from '../src/sync.js'
import { syncContract } from '../src/sync.js'
import {
  REPO_ROOT,
  fixture,
  listFiles,
  makeProject,
  moduleSpecifiers,
  readTree,
  removeProject,
  runTsc,
  writeBinderConsumers,
} from './helpers.js'

/** Copies a fixture into a fresh project as `openapi/<name>`, the way a user would keep it. */
async function projectWithSpec(name: string): Promise<{ root: string; input: string }> {
  const root = await makeProject()
  await fsp.mkdir(path.join(root, 'openapi'))
  await fsp.copyFile(fixture(name), path.join(root, 'openapi', name))
  return { root, input: `openapi/${name}` }
}

const EXPECTED_FILES = [
  '@tanstack/react-query.gen.ts',
  'client.gen.ts',
  'client/client.gen.ts',
  'client/index.ts',
  'client/types.gen.ts',
  'client/utils.gen.ts',
  'core/auth.gen.ts',
  'core/bodySerializer.gen.ts',
  'core/params.gen.ts',
  'core/pathSerializer.gen.ts',
  'core/queryKeySerializer.gen.ts',
  'core/serverSentEvents.gen.ts',
  'core/types.gen.ts',
  'core/utils.gen.ts',
  'index.ts',
  'sdk.gen.ts',
  'types.gen.ts',
]

const CASES = [
  { title: 'customers — OpenAPI 3.1 JSON', file: 'customers.openapi.json' },
  { title: 'orders — OpenAPI 3.0 YAML without operationIds', file: 'orders.openapi.yaml' },
  { title: 'PostgREST — Swagger 2.0', file: 'postgrest.swagger.json' },
]

describe.each(CASES)('$title', ({ file }) => {
  let project: { root: string; input: string }
  let result: SyncContractResult

  beforeAll(async () => {
    project = await projectWithSpec(file)
    result = await syncContract({ input: project.input, cwd: project.root })
  })
  afterAll(async () => {
    await removeProject(project.root)
  })

  it('writes the hey-api file set into src/api/generated and the manifest at the root', async () => {
    expect(result.outputDir).toBe(path.join(project.root, 'src/api/generated'))
    expect(result.files).toEqual(EXPECTED_FILES)
    expect(await listFiles(result.outputDir)).toEqual(EXPECTED_FILES)
    expect(result.manifestPath).toBe(path.join(project.root, 'trivia.manifest.json'))
    // Nothing left behind next to the output (staging directories are renamed or removed).
    expect((await fsp.readdir(path.join(project.root, 'src/api'))).sort()).toEqual(['generated'])
  })

  it('type-checks: tsc --noEmit over the generated code and binder-shaped consumers reports zero errors', async () => {
    const consumers = await writeBinderConsumers(project.root, result.manifest)
    expect(consumers.length).toBeGreaterThan(0)
    const { code, output } = await runTsc(project.root)
    expect(output).toBe('')
    expect(code).toBe(0)
  })

  it('the type-check is not vacuous: a binding that reads a wrong list property fails tsc', async () => {
    const list = result.manifest.resources.find((resource) => resource.operations.list)?.operations.list
    if (!list) throw new Error('every fixture has a list operation')
    const wrong = path.join(project.root, 'src/bindings/Wrong.tsx')
    await fsp.writeFile(
      wrong,
      [
        `import { useQuery } from '@tanstack/react-query'`,
        `import { ${list.queryOptionsFn} } from '${result.manifest.modules.queries.importPath}'`,
        `export function Wrong() {`,
        `  const { data } = useQuery({ ...${list.queryOptionsFn}() })`,
        `  return data?.definitelyNotAListProperty ?? null`,
        `}`,
        '',
      ].join('\n'),
    )
    try {
      const { code, output } = await runTsc(project.root)
      expect(code).not.toBe(0)
      expect(output).toContain('src/bindings/Wrong.tsx')
      expect(output).toContain('definitelyNotAListProperty')
    } finally {
      await fsp.rm(wrong)
    }
  })

  it('imports nothing at runtime but relative modules and @tanstack/react-query', async () => {
    const tree = await readTree(result.outputDir)
    const external = new Set<string>()
    for (const [name, text] of tree) {
      for (const specifier of moduleSpecifiers(text)) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) external.add(`${name} → ${specifier}`)
      }
    }
    expect([...external]).toEqual(['@tanstack/react-query.gen.ts → @tanstack/react-query'])
  })

  it('is deterministic: a run in a different project directory produces byte-identical files', async () => {
    const other = await projectWithSpec(file)
    try {
      const second = await syncContract({ input: other.input, cwd: other.root })
      expect(await readTree(second.outputDir)).toEqual(await readTree(result.outputDir))
      expect(await fsp.readFile(second.manifestPath, 'utf8')).toBe(await fsp.readFile(result.manifestPath, 'utf8'))
    } finally {
      await removeProject(other.root)
    }
  })

  it('re-running in place replaces the previous output with the same bytes', async () => {
    const before = await readTree(result.outputDir)
    const manifestBefore = await fsp.readFile(result.manifestPath, 'utf8')
    await syncContract({ input: project.input, cwd: project.root })
    expect(await readTree(result.outputDir)).toEqual(before)
    expect(await fsp.readFile(result.manifestPath, 'utf8')).toBe(manifestBefore)
  })
})

describe('runContractSync', () => {
  let root: string
  beforeAll(async () => {
    root = await makeProject()
  })
  afterAll(async () => {
    await removeProject(root)
  })

  it('returns the generated files and the resolved module paths', async () => {
    const result = await runContractSync({ input: fixture('customers.openapi.json'), outputDir: 'src/api/generated', cwd: root })
    const outputDir = path.join(root, 'src/api/generated')
    expect(result.outputDir).toBe(outputDir)
    expect(result.files).toEqual(EXPECTED_FILES)
    expect(result.modules).toEqual({
      queries: path.join(outputDir, '@tanstack/react-query.gen.ts'),
      sdk: path.join(outputDir, 'sdk.gen.ts'),
      types: path.join(outputDir, 'types.gen.ts'),
      client: path.join(outputDir, 'client.gen.ts'),
      index: path.join(outputDir, 'index.ts'),
    })
    for (const file of Object.values(result.modules)) expect(fs.existsSync(file)).toBe(true)
    expect(result.spec['openapi']).toBe('3.1.0')
  })

  it('does not mutate the spec object it is given', async () => {
    const spec = JSON.parse(await fsp.readFile(fixture('customers.openapi.json'), 'utf8')) as Record<string, unknown>
    const snapshot = JSON.stringify(spec)
    const result = await runContractSync({ input: spec, outputDir: 'out/object-input', cwd: root })
    expect(result.source).toBe('<object>')
    expect(JSON.stringify(spec)).toBe(snapshot)
  })

  it('refuses clients whose bundle would import a runtime package', async () => {
    await expect(
      runContractSync({
        input: fixture('customers.openapi.json'),
        outputDir: 'out/axios',
        cwd: root,
        client: '@hey-api/client-axios' as unknown as HeyApiClientPlugin,
      }),
    ).rejects.toMatchObject({ code: 'usage' })
    expect(fs.existsSync(path.join(root, 'out/axios'))).toBe(false)
  })
})

describe('owner safety', () => {
  let root: string
  beforeAll(async () => {
    root = await makeProject()
  })
  afterAll(async () => {
    await removeProject(root)
  })

  it('refuses to replace an output directory holding files hey-api did not write', async () => {
    const outputDir = path.join(root, 'src/api/generated')
    await fsp.mkdir(outputDir, { recursive: true })
    await fsp.writeFile(path.join(outputDir, 'keep-me.ts'), 'export const mine = 1\n')
    const error = await syncContract({ input: fixture('customers.openapi.json'), cwd: root }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ContractSyncError)
    expect(error).toMatchObject({ code: 'unsafe_output_dir' })
    expect((error as Error).message).toContain('keep-me.ts')
    expect(await fsp.readFile(path.join(outputDir, 'keep-me.ts'), 'utf8')).toBe('export const mine = 1\n')
    expect(await listFiles(outputDir)).toEqual(['keep-me.ts'])
    expect(fs.existsSync(path.join(root, 'trivia.manifest.json'))).toBe(false)
    await fsp.rm(outputDir, { recursive: true })
  })

  it('leaves the previous output and manifest untouched when a later run fails', async () => {
    const good = await syncContract({ input: fixture('customers.openapi.json'), cwd: root })
    const before = await readTree(good.outputDir)
    const manifestBefore = await fsp.readFile(good.manifestPath, 'utf8')
    const noOperations = path.join(root, 'empty.openapi.json')
    await fsp.writeFile(noOperations, JSON.stringify({ openapi: '3.1.0', info: { title: 'Empty', version: '1' }, paths: {} }))
    await expect(syncContract({ input: noOperations, cwd: root })).rejects.toMatchObject({ code: 'codegen_failed' })
    expect(await readTree(good.outputDir)).toEqual(before)
    expect(await fsp.readFile(good.manifestPath, 'utf8')).toBe(manifestBefore)
    expect((await fsp.readdir(path.join(root, 'src/api'))).sort()).toEqual(['generated'])
  })
})

describe('isolation from the working directory', () => {
  let baseline: Map<string, string>
  let root: string
  const cwdBefore = process.cwd()

  beforeAll(async () => {
    const clean = await makeProject()
    try {
      const result = await syncContract({ input: fixture('customers.openapi.json'), cwd: clean })
      baseline = await readTree(result.outputDir)
    } finally {
      await removeProject(clean)
    }
    root = await makeProject()
  })
  afterAll(async () => {
    process.chdir(cwdBefore)
    await removeProject(root)
  })

  it('ignores an openapi-ts.config.* in the working directory (hey-api would merge it)', async () => {
    await fsp.writeFile(
      path.join(root, 'openapi-ts.config.json'),
      JSON.stringify({ output: { header: '// POISONED', fileName: { suffix: '.poison' } } }),
    )
    process.chdir(root)
    try {
      const result = await syncContract({ input: fixture('customers.openapi.json'), cwd: root })
      expect(await readTree(result.outputDir)).toEqual(baseline)
    } finally {
      process.chdir(cwdBefore)
      await fsp.rm(path.join(root, 'openapi-ts.config.json'))
    }
  })

  it('refuses to run when an .openapi-tsrc in the working directory would leak into the config', async () => {
    await fsp.writeFile(path.join(root, '.openapi-tsrc'), 'output.header=// POISONED\n')
    process.chdir(root)
    try {
      await expect(
        syncContract({ input: fixture('customers.openapi.json'), cwd: root, outputDir: 'src/rc-run' }),
      ).rejects.toMatchObject({ code: 'environment' })
    } finally {
      process.chdir(cwdBefore)
      await fsp.rm(path.join(root, '.openapi-tsrc'))
    }
    expect(fs.existsSync(path.join(root, 'src/rc-run'))).toBe(false)
  })
})

describe('runtime independence of the template app', () => {
  it('examples/playground/package.json depends on no proprietary data runtime', async () => {
    const pkg = JSON.parse(await fsp.readFile(path.join(REPO_ROOT, 'examples/playground/package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >
    const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const
    const all = sections.flatMap((section) => Object.keys(pkg[section] ?? {}))
    expect(all.filter((name) => name === '@tangojs/boot' || name.startsWith('@refinedev/'))).toEqual([])
    // Only dev tooling may come from @trivia/*; nothing the app ships at runtime.
    expect(Object.keys(pkg['dependencies'] ?? {}).filter((name) => name.startsWith('@trivia/'))).toEqual([])
  })
})
