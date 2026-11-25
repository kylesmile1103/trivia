import { appSchema, loadBlueprint } from '@trivia/blueprint'
import { expect, it } from 'vitest'

import { fixture, kitManifests, missingKitTypes } from './kit-fixture.js'

it('SC-001 covers every published kit manifest with a fixture page', () => {
  expect(appSchema.safeParse(loadBlueprint(fixture()).docs['app.blueprint.json']?.doc).success).toBe(true)
  expect(missingKitTypes(kitManifests(), fixture())).toEqual([])
})

it('SC-001 reports a manifest type missing from the fixture', () => {
  expect(missingKitTypes([{ type: 'MissingExample' }], fixture())).toEqual(['MissingExample'])
})
