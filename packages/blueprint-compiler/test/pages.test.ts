import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { loadBlueprint, pageDocPath, revOfText, type ComponentManifest } from '@trivia/blueprint'
import * as engine from '@trivia/engine'
import { expect, it } from 'vitest'

import { compilePage, projectFacts, type CompileContext } from '../src/index.js'

const kit = ['Button', 'Card', 'Input'].map((type) => JSON.parse(fs.readFileSync(new URL(
  '../../blueprint/fixtures/manifests/kit-sample/' + type + '.manifest.json', import.meta.url,
), 'utf8')) as ComponentManifest)

const contract: NonNullable<CompileContext['contract']> = JSON.parse(fs.readFileSync(new URL(
  '../../../examples/refine-admin/trivia.manifest.json', import.meta.url,
), 'utf8'))
const account = contract.resources.find(({ name }) => name === 'Account')!
account.customOperations.push({
  ...account.operations.get!, kind: 'custom', operationId: 'getAccountStats', sdkFn: 'getAccountStats',
  path: '/api/v1/accounts/{id}/stats',
}, {
  ...account.operations.update!, kind: 'custom', operationId: 'closeAccount', sdkFn: 'closeAccount',
  method: 'POST', path: '/api/v1/accounts/{id}/close',
})
const context: CompileContext = {
  facts: projectFacts(),
  engine, contract,
  manifests: Object.fromEntries(kit.map((manifest) => [manifest.type, { ...manifest, installed: true }])),
}

function golden(fixture: string, name: string) {
  const dir = new URL('../fixtures/pages/' + fixture + '/', import.meta.url)
  const blueprint = loadBlueprint({ [pageDocPath(name)]: fs.readFileSync(new URL(name + '.page.json', dir), 'utf8') })
  const expected = fs.readFileSync(new URL(name + '.tsx', dir), 'utf8')
  const emitted = compilePage(blueprint, name, context)
  expect(emitted).toMatchObject({
    file: 'src/pages/' + name + '/' + name + '.tsx', code: expected, requires: [],
  })
  return emitted
}

it('FR-RC-01 and FR-RC-04: emits ordered static nodes and derives component imports', () => {
  golden('static', 'StaticPage')
})

it('FR-RC-03: lowers state and an exposed input to controlled props and text', () => {
  golden('state', 'SearchPanel')
})

it('FR-RC-03: binds list, one and custom query results and orders dependent hooks', () => {
  golden('queries', 'AccountQueries')
})

it('FR-RC-03: runs all action steps in order and produces one typed call handler stub', () => {
  expect(golden('actions', 'AccountActions').handler).toEqual({
    file: 'src/handlers/AccountActions.ts',
    code: fs.readFileSync(new URL('../fixtures/pages/actions/AccountActions.handler.ts', import.meta.url), 'utf8'),
  })
})

it('FR-RC-03: emits keyed repeats, scoped conditions and the component slot wrappers', () => {
  golden('control', 'AccountCard')
})

const cases = [
  ['static', 'StaticPage'], ['state', 'SearchPanel'], ['queries', 'AccountQueries'],
  ['actions', 'AccountActions'], ['control', 'AccountCard'],
] as const

it('SC-001 and SC-005: all goldens parse, typecheck in the fixture app and have no Trivia imports', () => {
  for (const [fixture, name] of cases) {
    const emitted = golden(fixture, name)
    expect(() => engine.annotate(emitted.code, emitted.file)).not.toThrow()
    for (const text of [emitted.code, emitted.handler?.code ?? '']) {
      expect(text).not.toMatch(/from ["']@trivia\//)
      expect(text).not.toContain('\r')
    }
  }
  const app = fileURLToPath(new URL('../../../examples/blueprint-fixture/', import.meta.url))
  const files = execFileSync(process.execPath, ['typecheck.mjs', '--listFiles'], { cwd: app, encoding: 'utf8' })
    .replaceAll('\\', '/').split(/\r?\n/).filter((file) => /\/trivia-golden-tsc-[^/]+\/src\//.test(file))
  for (const [, name] of cases) expect(files.some((file) => file.endsWith('/' + name + '.tsx')), name).toBe(true)
  expect(files.some((file) => file.endsWith('/handlers/AccountActions.ts'))).toBe(true)
}, 60_000)

it('SC-002: 20 shuffled documents compile to one set of bytes', () => {
  const original = Object.fromEntries(cases.map(([fixture, name]) => [
    pageDocPath(name),
    JSON.parse(fs.readFileSync(new URL('../fixtures/pages/' + fixture + '/' + name + '.page.json', import.meta.url), 'utf8')),
  ]))
  const hashes = new Set<string>()
  for (let seed = 1; seed <= 20; seed++) {
    let random = seed
    const shuffle = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(shuffle)
      if (value === null || typeof value !== 'object') return value
      const entries = Object.entries(value)
      for (let i = entries.length - 1; i > 0; i--) {
        random = (Math.imul(1664525, random) + 1013904223) >>> 0
        const j = random % (i + 1)
        ;[entries[i], entries[j]] = [entries[j]!, entries[i]!]
      }
      return Object.fromEntries(entries.map(([key, val]) => [key, shuffle(val)]))
    }
    const shuffled = shuffle(original) as Record<string, unknown>
    const blueprint = loadBlueprint(Object.fromEntries(Object.entries(shuffled).map(([file, doc]) => [file, JSON.stringify(doc)])))
    hashes.add(revOfText(cases.map(([, name]) => {
      const emitted = compilePage(blueprint, name, context)
      return emitted.code + (emitted.handler?.code ?? '')
    }).join('\n')))
  }
  expect(hashes.size).toBe(1)
})
