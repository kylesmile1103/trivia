import fs from 'node:fs'
import { SourceMap } from 'node:module'
import path from 'node:path'

import { parseSync, Visitor, type ESTree, type ResolvedConfig } from 'vite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { type EngineBinding, loadEngine, unwrap } from '@trivia/dev-service'
import { annotateModule, isSyntaxError } from '@trivia/dev-service/stamp'
import astLocator from '../src/index.js'
import { moduleFile } from '../src/transform.js'
import { PLAYGROUND, copyPlayground, startServer, type TestServer } from './helpers.js'

let engine: EngineBinding
const annotate = (code: string, file: string) => engine.annotate(code, file)

beforeAll(async () => {
  engine = await loadEngine()
})

interface Opening {
  name: string
  /** End of the tag name (and type arguments): where the first attribute starts. */
  nameEnd: number
  start: number
  /** First attribute as written, e.g. `data-ast-node="…"`. */
  first: { name: string | null; start: number; value: string | null } | null
}

function tagName(name: ESTree.JSXElementName | ESTree.JSXMemberExpression['object']): string {
  switch (name.type) {
    case 'JSXIdentifier':
      return name.name
    case 'JSXNamespacedName':
      return `${name.namespace.name}:${name.name.name}`
    case 'JSXMemberExpression':
      return `${tagName(name.object)}.${name.property.name}`
    default:
      return 'this'
  }
}

/** Every JSX opening element, found by Vite's own parser (independent of the engine). */
function openings(code: string, file: string): Opening[] {
  const { program, errors } = parseSync(file, code)
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
  const found: Opening[] = []
  new Visitor({
    JSXOpeningElement(node) {
      const attr = node.attributes[0]
      found.push({
        name: tagName(node.name),
        nameEnd: node.typeArguments?.end ?? node.name.end,
        start: node.start,
        first:
          attr === undefined
            ? null
            : attr.type === 'JSXSpreadAttribute'
              ? { name: null, start: attr.start, value: null }
              : {
                  name: tagName(attr.name as ESTree.JSXIdentifier),
                  start: attr.start,
                  value: attr.value?.type === 'Literal' ? String(attr.value.value) : null,
                },
      })
    },
  }).visit(program)
  return found
}

const isFragment = (o: Opening) => o.name === 'Fragment' || o.name === 'React.Fragment'
const strip = (code: string) => code.replaceAll(/ data-ast-node="[^"]*"/g, '')

function tsxFiles(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return tsxFiles(full, base)
    return /\.[jt]sx$/.test(e.name) ? [path.relative(base, full).split(path.sep).join('/')] : []
  })
}

describe('annotateModule', () => {
  const files = tsxFiles(path.join(PLAYGROUND, 'src'), PLAYGROUND)

  it('FR-TN-01 skips the parser for modules without a JSX opening token', () => {
    const parse = vi.fn(() => [])
    expect(annotateModule('export const answer = 42', 'src/answer.tsx', 'src/answer.tsx', parse)).toBeNull()
    expect(parse).not.toHaveBeenCalled()
  })

  it('covers the playground page and component library', () => {
    expect(files).toContain('src/pages/Dashboard.tsx')
    expect(files.filter((f) => f.startsWith('src/components/ui/')).length).toBeGreaterThanOrEqual(10)
  })

  it.each(files)('stamps every JSX opening element of %s, first, and nothing else', (file) => {
    const code = fs.readFileSync(path.join(PLAYGROUND, file), 'utf8')
    const elements = openings(code, file).filter((o) => !isFragment(o))
    const out = annotateModule(code, file, path.join(PLAYGROUND, file), annotate)
    if (elements.length === 0) {
      expect(out).toBeNull()
      return
    }
    expect(out).not.toBeNull()
    const stamped = openings(out!.code, file).filter((o) => !isFragment(o))
    expect(stamped).toHaveLength(elements.length)
    const locators = stamped.map((o) => {
      expect(o.first?.name, `<${o.name}> at ${o.start}`).toBe('data-ast-node')
      expect(out!.code.slice(o.nameEnd, o.first!.start), 'attribute right after the tag name').toBe(' ')
      return o.first!.value!
    })
    for (const loc of locators) expect(loc).toMatch(new RegExp(`^${file.replaceAll('.', '\\.')}#[\\w$]+#\\d+(\\.\\d+)*$`))
    expect(new Set(locators).size).toBe(locators.length)
    // Byte-exact everywhere else.
    expect(strip(out!.code)).toBe(code)
  })

  it('stamps locators the engine resolves back to the same element', () => {
    const file = 'src/pages/Dashboard.tsx'
    const code = fs.readFileSync(path.join(PLAYGROUND, file), 'utf8')
    const stamped = openings(annotateModule(code, file, file, annotate)!.code, file)
    expect(stamped).toHaveLength(17)
    for (const o of stamped) {
      const details = unwrap<{ name: string }>(engine.inspect(PLAYGROUND, o.first!.value!))
      expect(details.name).toBe(o.name)
    }
  })

  const unicode = [
    'const greeting = "héllo 😀 世界" // 😀 𝄞',
    'export function Wide() {',
    '  return (',
    '    <section title="𝒳 ✓">',
    '      <h1>😀😀 Ünïcødé</h1>',
    '      {/* 💬 */}<p className="a">日本語</p>',
    '      <Card.Header><b>𝄞</b></Card.Header>',
    '    </section>',
    '  )',
    '}',
    '',
  ].join('\n')

  it('places attributes by UTF-16 offset around astral and multi-byte characters', () => {
    const out = annotateModule(unicode, 'src/Wide.tsx', '/abs/src/Wide.tsx', annotate)!
    const stamped = openings(out.code, 'Wide.tsx')
    expect(stamped.map((o) => [o.name, o.first?.value])).toEqual([
      ['section', 'src/Wide.tsx#Wide#0'],
      ['h1', 'src/Wide.tsx#Wide#0.0'],
      ['p', 'src/Wide.tsx#Wide#0.1'],
      ['Card.Header', 'src/Wide.tsx#Wide#0.2'],
      ['b', 'src/Wide.tsx#Wide#0.2.0'],
    ])
    for (const o of stamped) expect(out.code.slice(o.nameEnd, o.first!.start)).toBe(' ')
    expect(strip(out.code)).toBe(unicode)
  })

  it('returns a source map that maps code after each injection back to the original', () => {
    const out = annotateModule(unicode, 'src/Wide.tsx', '/abs/src/Wide.tsx', annotate)!
    const map = new SourceMap(out.map as unknown as ConstructorParameters<typeof SourceMap>[0])
    const lineCol = (text: string, index: number) => {
      const before = text.slice(0, index)
      return { line: before.split('\n').length - 1, column: index - (before.lastIndexOf('\n') + 1) }
    }
    expect(out.map.sources).toEqual(['/abs/src/Wide.tsx'])
    // Tokens that follow an injected attribute on the same line (the `className` sits after an emoji).
    for (const token of ['title="𝒳', 'className="a"', '日本語', '😀😀', 'Ünïcødé', '𝄞</b>', '</Card.Header>']) {
      expect(out.code.indexOf(token), token).toBeGreaterThan(0)
      const gen = lineCol(out.code, out.code.indexOf(token))
      const orig = lineCol(unicode, unicode.indexOf(token))
      const entry = map.findEntry(gen.line, gen.column) as { originalLine: number; originalColumn: number }
      expect([entry.originalLine, entry.originalColumn], token).toEqual([orig.line, orig.column])
    }
    // A position inside an injected attribute maps into the tag that received it.
    const injected = out.code.indexOf(' data-ast-node="src/Wide.tsx#Wide#0.1"') + 5
    const gen = lineCol(out.code, injected)
    const entry = map.findEntry(gen.line, gen.column) as { originalLine: number; originalColumn: number }
    const tag = lineCol(unicode, unicode.indexOf('<p className'))
    expect(entry.originalLine).toBe(tag.line)
    expect(entry.originalColumn).toBeGreaterThanOrEqual(tag.column)
    expect(entry.originalColumn).toBeLessThanOrEqual(tag.column + '<p'.length)
  })

  it('throws a recognisable syntax error for code that does not parse', () => {
    let caught: unknown
    try {
      annotateModule('export const A = () => <div>', 'src/A.tsx', 'src/A.tsx', annotate)
    } catch (error) {
      caught = error
    }
    expect(isSyntaxError(caught)).toBe(true)
  })

  it('returns null for a module without JSX', () => {
    expect(annotateModule('export const n: number = 1\n', 'src/n.tsx', 'src/n.tsx', annotate)).toBeNull()
  })
})

describe('moduleFile', () => {
  const roots = ['/work/app', '/private/work/app']

  it('maps ids under a root to project-relative paths', () => {
    expect(moduleFile('/work/app/src/pages/Dashboard.tsx', roots)).toBe('src/pages/Dashboard.tsx')
    expect(moduleFile('/private/work/app/src/App.jsx', roots)).toBe('src/App.jsx')
    expect(moduleFile('/work/app/src/App.tsx?t=1712345678', roots)).toBe('src/App.tsx')
    expect(moduleFile('/work/app/src/App.tsx?v=abc123', roots)).toBe('src/App.tsx')
  })

  it('skips modules the plugin must not annotate', () => {
    expect(moduleFile('/work/app/node_modules/lib/x.jsx', roots)).toBeNull()
    expect(moduleFile('\0virtual:thing.tsx', roots)).toBeNull()
    expect(moduleFile('/work/app/src/App.tsx?raw', roots)).toBeNull()
    expect(moduleFile('/work/app/src/App.tsx?worker&url', roots)).toBeNull()
    expect(moduleFile('/work/other/src/App.tsx', roots)).toBeNull()
    expect(moduleFile('/work/app/../app2/x.tsx', roots)).toBeNull()
    expect(moduleFile('/work/app/src/util.ts', roots)).toBeNull()
    expect(moduleFile('src/App.tsx', roots)).toBeNull()
  })
})

describe('transform hook', () => {
  it('returns null on a syntax error instead of throwing, and warns on nothing', async () => {
    const plugin = astLocator({ api: false })
    const warn = vi.fn()
    const config = { root: '/work/app', resolve: { alias: [] }, logger: { warn } } as unknown as ResolvedConfig
    await (plugin.configResolved as (this: void, c: ResolvedConfig) => Promise<void>)(config)
    const { handler } = plugin.transform as { handler: (this: unknown, code: string, id: string) => unknown }
    const ctx = { warn: vi.fn() }
    expect(handler.call(ctx, 'export const A = () => <div>', '/work/app/src/A.tsx')).toBeNull()
    expect(ctx.warn).not.toHaveBeenCalled()
    const ok = handler.call(ctx, 'export const A = () => <div />', '/work/app/src/A.tsx') as { code: string }
    expect(ok.code).toBe('export const A = () => <div data-ast-node="src/A.tsx#A#0" />')
  })
})

describe('in a Vite dev server', () => {
  let root: string
  let server: TestServer

  beforeAll(async () => {
    root = copyPlayground()
    server = await startServer(root)
  })

  afterAll(async () => {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('runs before Vite compiles the JSX away', async () => {
    const result = await server.vite.transformRequest('/src/pages/Dashboard.tsx')
    expect(result).not.toBeNull()
    const locators = [...result!.code.matchAll(/"data-ast-node": "([^"]+)"/g)].map((m) => m[1])
    expect(locators).toHaveLength(17)
    expect(locators[0]).toBe('src/pages/Dashboard.tsx#Dashboard#0')
    expect(locators).toContain('src/pages/Dashboard.tsx#Dashboard#0.0.2.1')
  })

  it('annotates the component library too', async () => {
    const result = await server.vite.transformRequest('/src/components/ui/button.tsx')
    expect(result!.code).toContain('"data-ast-node": "src/components/ui/button.tsx#Button#0"')
  })

  it("leaves a syntax error to Vite's own transform", async () => {
    fs.writeFileSync(path.join(root, 'src/Broken.tsx'), 'export function Broken() {\n  return <div>\n}\n')
    const error = await server.vite.transformRequest('/src/Broken.tsx').then(
      () => null,
      (e: unknown) => e as { plugin?: string; message: string },
    )
    expect(error).not.toBeNull()
    expect(error!.plugin).not.toBe('trivia:ast-locator')
    expect(error!.message).not.toContain('[trivia]')
  })
})
