import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'
import { loadBlueprint } from '../store.js'
import { validateStructure } from './index.js'

const invalid = path.join(FIXTURES, 'invalid')
const codes = fs.readdirSync(invalid).filter((code) => code !== 'schema_violation').sort()

describe('reference diagnostics (layer 2, US3)', () => {
  it('has a fixture for every code of the layer', () => {
    expect(codes).toEqual([
      'dangling_reference', 'duplicate_name', 'duplicate_order', 'duplicate_prop', 'duplicate_route',
      'file_name_mismatch', 'invalid_root', 'missing_document', 'missing_slot', 'parent_cycle',
    ])
  })

  it('finds nothing in the valid fixture', () => {
    expect(validateStructure(loadBlueprint(readFixture(path.join(FIXTURES, 'valid/backoffice'))))).toEqual([])
  })

  for (const code of codes) {
    for (const name of fs.readdirSync(path.join(invalid, code)).sort()) {
      it(`${code}/${name}`, () => {
        const dir = path.join(invalid, code, name)
        const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'))
        const found = validateStructure(loadBlueprint(readFixture(dir)))
        expect(found.map(({ code, severity, doc, pointer }) => ({ code, severity, doc, pointer }))).toEqual(expected)
        for (const d of found) expect(d.message.length).toBeGreaterThan(0)
      })
    }
  }

  it('skips the reference checks of a document that failed its schema', () => {
    const dir = path.join(invalid, 'dangling_reference/parent')
    const files = readFixture(dir)
    const broken = { ...files, 'pages/Home.page.json': (files['pages/Home.page.json'] as string).replace('"route": "/"', '"route": 7') }
    expect(validateStructure(loadBlueprint(broken)).map((d) => d.code)).toEqual(['schema_violation'])
  })
})
