import { join } from 'node:path'

import { expect, it } from 'vitest'

import { FIXTURES, readFixture } from '../../test/helpers.js'

const kit = () => readFixture(join(FIXTURES, 'manifests/kit-sample'))

it('FR-MF-01: ships Button, Input and Card as manifest examples', () => {
  const files = kit()
  expect(Object.keys(files).sort()).toEqual(['Button.manifest.json', 'Card.manifest.json', 'Input.manifest.json'])
  for (const [file, text] of Object.entries(files)) {
    const manifest = JSON.parse(text)
    expect(file).toBe(`${manifest.type}.manifest.json`)
    expect(manifest.source).toMatchObject({
      registry: 'shadcn',
      item: manifest.type.toLowerCase(),
      import: { name: manifest.type, from: 'ui' },
    })
  }
})

it('FR-MF-01: describes text, actions, controlled inputs and wrapper slots', () => {
  const files = kit()
  expect(JSON.parse(files['Button.manifest.json']!)).toMatchObject({
    slots: [{ name: 'children', kind: 'text' }],
    events: [{ name: 'onClick', prop: 'onClick' }],
    client: true,
    template: { children: 'Button' },
  })
  expect(JSON.parse(files['Input.manifest.json']!)).toMatchObject({
    slots: [],
    exposes: [{
      name: 'value', type: 'string', initial: '',
      via: { valueProp: 'value', changeProp: 'onChange', changeArg: 'event.target.value' },
    }],
  })
  expect(JSON.parse(files['Card.manifest.json']!)).toMatchObject({
    source: { parts: { header: 'CardHeader', content: 'CardContent', footer: 'CardFooter' } },
    slots: [
      { name: 'header', kind: 'nodes', wrapper: 'CardHeader' },
      { name: 'content', kind: 'nodes', wrapper: 'CardContent' },
      { name: 'footer', kind: 'nodes', wrapper: 'CardFooter' },
    ],
  })
})
