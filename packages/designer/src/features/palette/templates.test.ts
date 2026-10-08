import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import type { ComponentSchema } from '@/shared/engine/types'
import type { Template } from '@/shared/template'

import { playgroundComponents } from './playground.fixture'
import { RECIPES, componentRefs, isCurated, templatesFor } from './templates'

/** Parse a snippet with a real TSX parser: its single root element and every tag name used. */
function parseSnippet(snippet: string): { root: string; tags: string[] } {
  const source = `const __snippet = (\n${snippet}\n)\n`
  const { diagnostics = [] } = ts.transpileModule(source, {
    fileName: 'snippet.tsx',
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve },
  })
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; '))
  }
  const file = ts.createSourceFile('snippet.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const [statement, ...rest] = file.statements
  if (statement === undefined || rest.length > 0 || !ts.isVariableStatement(statement)) throw new Error('not one expression')
  let expr = statement.declarationList.declarations[0]?.initializer
  while (expr !== undefined && ts.isParenthesizedExpression(expr)) expr = expr.expression
  if (expr === undefined || !(ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr))) {
    throw new Error(`root is not a JSX element: ${expr === undefined ? 'nothing' : ts.SyntaxKind[expr.kind]}`)
  }
  const tagOf = (node: ts.JsxElement | ts.JsxSelfClosingElement) =>
    (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText(file)
  const tags: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) tags.push(node.tagName.getText(file))
    ts.forEachChild(node, visit)
  }
  visit(expr)
  return { root: tagOf(expr), tags }
}

/** Component (capitalized) tags, reduced to the binding they need: `Foo.Bar` → `Foo`. */
function componentTags(tags: string[]): Set<string> {
  return new Set(tags.filter((t) => /^[A-Z]/.test(t)).map((t) => t.split('.')[0] as string))
}

/** The checks every template must pass, whichever path produced it. */
function expectValid(template: Template) {
  const { root, tags } = parseSnippet(template.snippet)
  expect(root, template.label).toBe(template.component)
  const imported = template.imports.map((i) => i.name)
  expect(new Set(imported).size, `${template.label}: duplicate imports`).toBe(imported.length)
  // Every component tag is imported, and nothing imported goes unused.
  expect(new Set(imported), template.label).toEqual(componentTags(tags))
  expect(template.snippet.startsWith('<'), `${template.label}: root must be unindented`).toBe(true)
}

/** One module per recipe family, exporting every name the recipes reference. */
function libraryFor(names: string[]): ComponentSchema[] {
  return names.map((name) => {
    const family = familyOf(name)
    const file = family.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
    return schema(name, `src/components/ui/${file}.tsx`, `@/components/ui/${file}`)
  })
}

const FAMILIES = Object.keys(RECIPES).sort((a, b) => b.length - a.length)
function familyOf(name: string): string {
  return FAMILIES.find((f) => name.startsWith(f)) ?? name
}

function schema(name: string, file: string, importSource: string, extra: Partial<ComponentSchema> = {}): ComponentSchema {
  return { name, file, importSource, baseElement: null, acceptsChildren: true, props: [], ...extra }
}

const allRecipeNames = [...new Set(Object.values(RECIPES).flatMap(componentRefs))]

describe('recipes', () => {
  it.each(Object.entries(RECIPES))('%s is a single JSX element rooted at its component', (name, snippet) => {
    const { root, tags } = parseSnippet(snippet)
    expect(root).toBe(name)
    // componentRefs (a fast scan used at runtime) agrees with the real parser.
    expect(new Set(componentRefs(snippet))).toEqual(componentTags(tags))
  })

  it('uses two-space nesting with an unindented root, for the engine to re-indent', () => {
    for (const snippet of Object.values(RECIPES)) {
      const lines = snippet.split('\n')
      expect(lines[0]?.startsWith('<')).toBe(true)
      for (const line of lines) expect((line.length - line.trimStart().length) % 2, line).toBe(0)
      if (lines.length > 1) expect(lines.at(-1)?.startsWith('</')).toBe(true)
    }
  })
})

describe('templatesFor', () => {
  it('gives every playground component a valid template', () => {
    const templates = templatesFor(playgroundComponents)
    expect(templates.map((t) => t.component)).toEqual(playgroundComponents.map((c) => c.name))
    for (const template of templates) expectValid(template)
  })

  it('curates the playground components that have recipes', () => {
    const curated = templatesFor(playgroundComponents).filter(isCurated).map((t) => t.component)
    expect(curated).toEqual([
      'Badge',
      'Button',
      'Card',
      'Checkbox',
      'Input',
      'Label',
      'Select',
      'Separator',
      'Switch',
      'Textarea',
    ])
  })

  it('builds the curated Card with every part imported from the card module', () => {
    const card = templatesFor(playgroundComponents).find((t) => t.component === 'Card')
    expect(card?.snippet).toBe(
      [
        '<Card>',
        '  <CardHeader>',
        '    <CardTitle>Title</CardTitle>',
        '    <CardDescription>Description</CardDescription>',
        '  </CardHeader>',
        '  <CardContent>Content</CardContent>',
        '</Card>',
      ].join('\n'),
    )
    expect(card?.imports).toEqual(
      ['Card', 'CardHeader', 'CardTitle', 'CardDescription', 'CardContent'].map((name) => ({
        name,
        source: '@/components/ui/card',
      })),
    )
  })

  it('builds a complete Select composition', () => {
    const select = templatesFor(playgroundComponents).find((t) => t.component === 'Select')
    expect(select && isCurated(select)).toBe(true)
    expect(select?.imports.map((i) => i.name)).toEqual(['Select', 'SelectTrigger', 'SelectValue', 'SelectContent', 'SelectItem'])
    expect(new Set(select?.imports.map((i) => i.source))).toEqual(new Set(['@/components/ui/select']))
  })

  it('offers each recipe, valid, when every component it needs exists', () => {
    const templates = templatesFor(libraryFor(allRecipeNames))
    for (const name of Object.keys(RECIPES)) {
      const template = templates.find((t) => t.component === name)
      expect(template && isCurated(template), name).toBe(true)
      if (template) expectValid(template)
    }
  })

  it('takes import sources from the analyzed components, not from a hardcoded path', () => {
    const library = libraryFor(allRecipeNames).map((c) => ({ ...c, importSource: c.importSource.replace('@/components/ui', '~/ui') }))
    for (const template of templatesFor(library)) {
      for (const spec of template.imports) expect(spec.source.startsWith('~/ui/'), `${template.label}: ${spec.source}`).toBe(true)
    }
  })

  it('falls back to the generic template when a part is missing', () => {
    const withoutDescription = playgroundComponents.filter((c) => c.name !== 'CardDescription')
    const card = templatesFor(withoutDescription).find((t) => t.component === 'Card')
    expect(card).toEqual({
      component: 'Card',
      label: 'Card',
      snippet: '<Card>Card</Card>',
      imports: [{ name: 'Card', source: '@/components/ui/card' }],
    })
  })

  it('resolves parts in other modules (Dialog needs Button) and falls back without them', () => {
    const names = ['Dialog', 'DialogTrigger', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']
    const withButton = templatesFor([...libraryFor(names), schema('Button', 'src/components/ui/button.tsx', '@/components/ui/button')])
    const dialog = withButton.find((t) => t.component === 'Dialog')
    expect(dialog && isCurated(dialog)).toBe(true)
    expect(dialog?.imports).toContainEqual({ name: 'Button', source: '@/components/ui/button' })

    const without = templatesFor(libraryFor(names)).find((t) => t.component === 'Dialog')
    expect(without?.snippet).toBe('<Dialog>Dialog</Dialog>')
  })

  it("prefers a part from the primary's own module when two modules export that name", () => {
    const library = [
      schema('Card', 'src/components/ui/card.tsx', '@/components/ui/card'),
      ...['CardHeader', 'CardTitle', 'CardDescription', 'CardContent'].map((n) =>
        schema(n, 'src/components/ui/fancy-card.tsx', '@/components/ui/fancy-card'),
      ),
      ...['CardHeader', 'CardTitle', 'CardDescription', 'CardContent'].map((n) =>
        schema(n, 'src/components/ui/card.tsx', '@/components/ui/card'),
      ),
    ]
    const card = templatesFor(library).find((t) => t.component === 'Card')
    expect(new Set(card?.imports.map((i) => i.source))).toEqual(new Set(['@/components/ui/card']))
  })

  it('writes generic templates as void or with children, plus required props', () => {
    const [plain, input, item] = templatesFor([
      schema('Widget', 'src/components/ui/widget.tsx', '@/components/ui/widget'),
      schema('Field', 'src/components/ui/field.tsx', '@/components/ui/field', { acceptsChildren: false }),
      schema('MenuItem', 'src/components/ui/menu.tsx', '@/components/ui/menu', {
        props: [
          { name: 'value', kind: 'string', optional: false, source: 'intrinsic' },
          { name: 'type', kind: 'enum', options: ['single', 'multiple'], optional: false, source: 'intrinsic' },
          { name: 'count', kind: 'number', optional: false, default: 3, source: 'declared' },
          { name: 'label', kind: 'string', optional: true, source: 'declared' },
          { name: 'render', kind: 'unknown', typeText: '() => void', optional: false, source: 'declared' },
        ],
      }),
    ])
    expect(plain?.snippet).toBe('<Widget>Widget</Widget>')
    expect(input?.snippet).toBe('<Field />')
    expect(item?.snippet).toBe('<MenuItem value="value" type="single" count={3}>MenuItem</MenuItem>')
    for (const t of [plain, input, item]) if (t) expectValid(t)
  })

  it('fills the playground SelectItem required value', () => {
    const item = templatesFor(playgroundComponents).find((t) => t.component === 'SelectItem')
    expect(item?.snippet).toBe('<SelectItem value="value">SelectItem</SelectItem>')
  })
})

describe('componentRefs', () => {
  it('lists root names once, in order, ignoring intrinsic tags and fragments', () => {
    expect(componentRefs('<Card><div><Foo.Bar /><>x</></div><Card /></Card>')).toEqual(['Card', 'Foo'])
  })
})
