import fs from 'node:fs'
import { SourceMap, createRequire } from 'node:module'
import path from 'node:path'

import astLocator from '@trivia/vite-plugin-ast-locator'
import { beforeAll, describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../../../crates/trivia_oxc_engine/tests/fixtures')
const fixtures = fs.readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.[jt]sx$/.test(entry.name))
  .map((entry) => path.join(entry.parentPath, entry.name))
  .sort()

type RawMap = ConstructorParameters<typeof SourceMap>[0]
type Loader = (this: {
  rootContext: string
  resourcePath: string
  getOptions(): { root: string }
  async(): (error: Error | null, code?: string, map?: RawMap) => void
}, code: string, inputMap?: RawMap) => void

function load(input: string, file: string, inputMap?: RawMap): Promise<{ code: string; map?: RawMap }> {
  const loader = createRequire(import.meta.url)('@trivia/next/loader') as Loader
  return new Promise((resolve, reject) => loader.call({
    rootContext: root,
    resourcePath: file,
    getOptions: () => ({ root }),
    async: () => (error, code, map) => error ? reject(error) : resolve({ code: code!, ...(map ? { map } : {}) }),
  }, input, inputMap))
}

const vite = astLocator({ api: false, uiDir: 'ui' })
beforeAll(async () => {
  const hook = vite.configResolved
  if (typeof hook !== 'function') throw new Error('expected a configResolved hook')
  await hook.call({} as never, { root, resolve: { alias: [] }, logger: console } as never)
})

describe('FR-TN-01 and SC-003: the Next webpack-style loader', () => {
  it('includes the Dashboard locators and their reformatted source', () => {
    expect(fixtures.map((f) => path.basename(f))).toEqual(expect.arrayContaining(['Dashboard.tsx', 'Dashboard.reformatted.tsx']))
  })

  it.each(fixtures)('stamps the same bytes as the Vite transform for %s', async (file) => {
    const input = fs.readFileSync(file, 'utf8')
    const transform = vite.transform
    if (!transform || typeof transform === 'function') throw new Error('expected an object transform hook')
    const expected = await transform.handler.call({ warn: console.warn } as never, input, file)
    const actual = await load(input, file)
    expect(actual.code).toBe(typeof expected === 'object' && expected !== null ? expected.code : input)
    if (typeof expected === 'object' && expected?.map) expect(actual.map).toEqual(JSON.parse(expected.map.toString()))
  })

  it('composes an upstream source map and passes it through unchanged for files without JSX', async () => {
    const input = '\nexport function Trace() { return <h1 id="probe">hi</h1> }'
    const prior: RawMap = {
      version: 3, file: 'Trace.tsx', sourceRoot: '', names: [],
      sources: ['original.tsx'], sourcesContent: [input.trimStart()], mappings: ';AAAA',
    }
    const file = path.join(root, 'Trace.tsx')
    const result = await load(input, file, prior)
    const entry = new SourceMap(result.map!).findEntry(1, result.code.split('\n')[1]!.indexOf('id='))
    expect(entry).toMatchObject({ originalSource: expect.stringMatching(/original\.tsx$/), originalLine: 0 })
    expect(await load('export const empty = 1', file, prior)).toEqual({ code: 'export const empty = 1', map: prior })
  })
})
