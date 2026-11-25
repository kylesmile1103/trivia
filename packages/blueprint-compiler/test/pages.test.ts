import fs from 'node:fs'

import { loadBlueprint, pageDocPath, type ComponentManifest } from '@trivia/blueprint'
import * as engine from '@trivia/engine'
import { expect, it } from 'vitest'

import { compilePage, projectFacts, type CompileContext } from '../src/index.js'

const kit = ['Button', 'Card', 'Input'].map((type) => JSON.parse(fs.readFileSync(new URL(
  '../../blueprint/fixtures/manifests/kit-sample/' + type + '.manifest.json', import.meta.url,
), 'utf8')) as ComponentManifest)

const context: CompileContext = {
  facts: projectFacts(),
  engine,
  manifests: Object.fromEntries(kit.map((manifest) => [manifest.type, { ...manifest, installed: true }])),
}

function golden(fixture: string, name: string) {
  const dir = new URL('../fixtures/pages/' + fixture + '/', import.meta.url)
  const blueprint = loadBlueprint({ [pageDocPath(name)]: fs.readFileSync(new URL(name + '.page.json', dir), 'utf8') })
  const expected = fs.readFileSync(new URL(name + '.tsx', dir), 'utf8')
  expect(compilePage(blueprint, name, context)).toMatchObject({
    file: 'src/pages/' + name + '/' + name + '.tsx', code: expected, requires: [],
  })
}

it('FR-RC-01 and FR-RC-04: emits ordered static nodes and derives component imports', () => {
  golden('static', 'StaticPage')
})

it('FR-RC-03: lowers state and an exposed input to controlled props and text', () => {
  golden('state', 'SearchPanel')
})
