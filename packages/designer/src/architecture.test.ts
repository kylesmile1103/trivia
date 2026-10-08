// The designer's layout, checked (docs/architecture.md):
//
//   app/              composition root: the shell that puts the features on screen
//   features/<name>/  vertical slices; each exposes its public API from index.ts
//   shared/           what any feature may use, knowing no feature
//
// Imports point down that list only: app → features → shared. A feature never imports
// another feature, and the app imports a feature only through its index. Within a slice,
// imports are relative.

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = import.meta.dirname
const LAYERS = ['app', 'features', 'shared']
// Import contexts only: other '@/…' strings are the user's import paths (palette templates).
const IMPORT = /(?:\bfrom|\bimport|\bvi\.mock|\bimport\()\s*\(?\s*['"]([^'"\n]+)['"]/g

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

/** Path under src/ of what `spec` names from `file`, or null for a package import. */
function target(file: string, spec: string): string | null {
  if (spec.startsWith('@/')) return spec.slice(2)
  if (spec.startsWith('.')) return path.relative(SRC, path.resolve(path.dirname(file), spec))
  return null
}

/** `app`, `features/<name>` or `shared`: the unit a path under src/ belongs to. */
function unitOf(rel: string): string {
  const [layer, name] = rel.split(path.sep).join('/').split('/')
  return layer === 'features' && name !== undefined ? `features/${name}` : (layer ?? '')
}

interface Import {
  from: string
  spec: string
  to: string
}

const imports: Import[] = sources(SRC).flatMap((file) =>
  [...fs.readFileSync(file, 'utf8').matchAll(IMPORT)].flatMap(([, spec = '']) => {
    const to = target(file, spec)
    return to === null ? [] : [{ from: path.relative(SRC, file).split(path.sep).join('/'), spec, to: to.split(path.sep).join('/') }]
  }),
)

const show = (list: Import[]) => list.map((i) => `${i.from}: '${i.spec}'`)

describe('the designer layout', () => {
  it('holds only app/, features/ and shared/ at the top of src/', () => {
    const top = fs.readdirSync(SRC, { withFileTypes: true })
    expect(top.filter((e) => e.isDirectory()).map((e) => e.name).sort()).toEqual(LAYERS)
    expect(top.filter((e) => !e.isDirectory()).map((e) => e.name)).toEqual(['architecture.test.ts'])
  })

  it('gives every feature an index.ts, its public API', () => {
    const features = fs.readdirSync(path.join(SRC, 'features'))
    expect(features.length).toBeGreaterThan(0)
    for (const name of features) expect(fs.existsSync(path.join(SRC, 'features', name, 'index.ts')), name).toBe(true)
  })

  it('keeps shared/ free of features and of the app', () => {
    const up = imports.filter((i) => unitOf(i.from) === 'shared' && unitOf(i.to) !== 'shared')
    expect(show(up)).toEqual([])
  })

  it('never lets one feature import another, or the app', () => {
    const across = imports.filter((i) => {
      const from = unitOf(i.from)
      const to = unitOf(i.to)
      return from.startsWith('features/') && to !== from && to !== 'shared'
    })
    expect(show(across)).toEqual([])
  })

  it('lets the app reach a feature only through its index', () => {
    const deep = imports.filter((i) => !unitOf(i.from).startsWith('features/') && unitOf(i.to).startsWith('features/') && i.spec !== `@/${unitOf(i.to)}`)
    expect(show(deep)).toEqual([])
  })

  it('imports within a slice relatively', () => {
    const aliased = imports.filter((i) => unitOf(i.from).startsWith('features/') && unitOf(i.to) === unitOf(i.from) && i.spec.startsWith('@/'))
    expect(show(aliased)).toEqual([])
  })
})
