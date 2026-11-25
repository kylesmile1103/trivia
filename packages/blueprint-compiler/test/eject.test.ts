import fs from 'node:fs'

import { loadBlueprint, pageDocPath, revOfText } from '@trivia/blueprint'
import * as engine from '@trivia/engine'
import { expect, it } from 'vitest'

import { compilePage, emptyLock, planEject, projectFacts, readLock, serializeLock, type EjectContext } from '../src/index.js'

const name = 'StaticPage'
const source = fs.readFileSync(new URL('../fixtures/pages/static/StaticPage.page.json', import.meta.url), 'utf8')
const blueprint = loadBlueprint({ [pageDocPath(name)]: source })
const button = JSON.parse(fs.readFileSync(new URL('../../blueprint/fixtures/manifests/kit-sample/Button.manifest.json', import.meta.url), 'utf8'))
const ctx: EjectContext = {
  compile: { facts: projectFacts(), engine, manifests: { Button: { ...button, installed: true } } },
  files: new Map(),
  routes: [],
  compiler: '0.2.0',
}

it('FR-RC-07 and FR-RC-08: creates or replaces only the exact locked page bytes', () => {
  const module = compilePage(blueprint, name, ctx.compile)
  const create = planEject(blueprint, [name], ctx, emptyLock())
  expect(create.ops).toEqual([{ op: 'createFile', file: module.file, content: module.code }])
  expect(create.lock.pages[name]).toEqual({
    file: module.file, hash: revOfText(module.code), blueprintRev: revOfText(source), route: module.route, component: module.component,
  })
  expect(readLock(serializeLock(create.lock))).toEqual(create.lock)
  expect(planEject(blueprint, [name], ctx, create.lock).ops).toEqual(create.ops)

  const existing = { ...ctx, files: new Map([[module.file, module.code]]),
    routes: [{ path: module.route, file: module.file, component: module.component }] }
  const replace = planEject(blueprint, [name], existing, create.lock)
  expect(replace.ops).toEqual([{ op: 'replaceFile', file: module.file, expectedHash: revOfText(module.code), content: module.code }])
  expect(replace.registrations).toEqual([])
  expect(() => planEject(blueprint, [name], {
    ...existing, files: new Map([[module.file, module.code + ' ']]),
  }, create.lock)).toThrow(expect.objectContaining({ code: 'conflict', details: expect.objectContaining({ page: name, file: module.file }) }))
})

it('FR-RC-08: refuses a foreign route or file even when the existing code is identical', () => {
  const module = compilePage(blueprint, name, ctx.compile)
  expect(() => planEject(blueprint, [name], {
    ...ctx, files: new Map([[module.file, module.code]]),
  }, emptyLock())).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(() => planEject(blueprint, [name], {
    ...ctx, routes: [{ path: module.route, file: 'src/Existing.tsx', component: 'Existing' }],
  }, emptyLock())).toThrow(expect.objectContaining({ code: 'conflict' }))
})

it('FR-RC-10: reports the registry item for a missing component', () => {
  const missing = loadBlueprint({ [pageDocPath(name)]: source.replace('"type": "Button"', '"type": "Select"') })
  const unavailable = { ...ctx, compile: {
    ...ctx.compile, manifests: {
      Select: { ...button, type: 'Select', installed: false, source: { ...button.source, item: 'select' } },
    },
  } }
  expect(() => planEject(missing, [name], unavailable, emptyLock())).toThrow(expect.objectContaining({
    code: 'unresolved_component', details: { requires: [{ registry: 'shadcn', item: 'select' }] },
  }))
})
