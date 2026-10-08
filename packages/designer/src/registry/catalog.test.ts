import { describe, expect, it } from 'vitest'

import type { ComponentSchema } from '@/bridge/types'
import { buildCatalog, countComponents, filterCatalog } from '@/registry/catalog'
import { playgroundComponents } from '@/registry/playground.fixture'

const outline = (groups: ReturnType<typeof buildCatalog>) =>
  groups.map((g) => ({ group: g.label, families: g.families.map((f) => f.primary.schema.name) }))

describe('buildCatalog', () => {
  it('groups the playground library, in palette order', () => {
    expect(outline(buildCatalog(playgroundComponents))).toEqual([
      { group: 'Form', families: ['Button', 'Input', 'Textarea', 'Label', 'Checkbox', 'Switch', 'Select'] },
      { group: 'Layout', families: ['Card', 'Separator'] },
      { group: 'Display', families: ['Badge'] },
    ])
  })

  it('nests the parts of a module under its primary component, in source order', () => {
    const card = buildCatalog(playgroundComponents)
      .flatMap((g) => g.families)
      .find((f) => f.primary.schema.name === 'Card')
    expect(card?.parts.map((p) => p.schema.name)).toEqual([
      'CardHeader',
      'CardTitle',
      'CardDescription',
      'CardAction',
      'CardContent',
      'CardFooter',
    ])
    expect(countComponents(buildCatalog(playgroundComponents))).toBe(playgroundComponents.length)
  })

  it('finds the primary by file name, case-insensitively, else takes the first export', () => {
    const lib: ComponentSchema[] = [
      component('InputOTPGroup', 'src/components/ui/input-otp.tsx'),
      component('InputOTP', 'src/components/ui/input-otp.tsx'),
      component('Toaster', 'src/components/ui/sonner.tsx'),
      component('FancyThing', 'src/components/ui/fancy.tsx'),
    ]
    expect(outline(buildCatalog(lib))).toEqual([
      { group: 'Form', families: ['InputOTP'] },
      { group: 'Feedback', families: ['Toaster'] },
      { group: 'Other', families: ['FancyThing'] },
    ])
  })
})

describe('filterCatalog', () => {
  const catalog = buildCatalog(playgroundComponents)

  it('returns everything for an empty query', () => {
    expect(filterCatalog(catalog, '  ').groups).toBe(catalog)
  })

  it('matches names, words inside names and synonyms', () => {
    expect(outline(filterCatalog(catalog, 'divider').groups)).toEqual([{ group: 'Layout', families: ['Separator'] }])
    expect(outline(filterCatalog(catalog, 'TEXT').groups)).toEqual([{ group: 'Form', families: ['Input', 'Textarea', 'Label'] }])
    expect(outline(filterCatalog(catalog, 'dropdown').groups)).toEqual([{ group: 'Form', families: ['Select'] }])
  })

  it('keeps only matching parts, and opens their family', () => {
    const { groups, expanded } = filterCatalog(catalog, 'card title')
    const card = groups.flatMap((g) => g.families).find((f) => f.primary.schema.name === 'Card')
    expect(card?.parts.map((p) => p.schema.name)).toEqual(['CardTitle'])
    expect(expanded.has('src/components/ui/card.tsx')).toBe(true)
  })

  it('keeps every part when the primary matches', () => {
    const { groups, expanded } = filterCatalog(catalog, 'select')
    const select = groups.flatMap((g) => g.families).find((f) => f.primary.schema.name === 'Select')
    expect(select?.parts).toHaveLength(9)
    expect(expanded.size).toBe(0)
  })

  it('returns no groups when nothing matches', () => {
    expect(filterCatalog(catalog, 'zzz').groups).toEqual([])
  })
})

function component(name: string, file: string): ComponentSchema {
  const importSource = file.replace(/^src\//, '@/').replace(/\.tsx$/, '')
  return { name, file, importSource, baseElement: null, acceptsChildren: true, props: [] }
}
